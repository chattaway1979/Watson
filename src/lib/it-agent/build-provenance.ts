// ============================================================
// Watson — 021G-3 : PACKAGE-EMBEDDED build provenance (SERVER-ONLY)
// ------------------------------------------------------------
// WHY THIS EXISTS
// The deploy guard used to prove a rollout was live by comparing /api/health's
// `commit` against the expected SHA. But `commit` came from the
// WATSON_DEPLOYED_SHA app setting, which the guard itself writes BEFORE it
// restarts the app. So the check validated the guard's own bookkeeping, not the
// bundle that was actually running: with WEBSITE_RUN_FROM_PACKAGE the previous
// package keeps serving until a restart remounts, and during that window health
// reported the NEW SHA while the OLD code answered requests. That is the same
// failure class as the 021D stale-bundle incident, and it was observed
// repeatedly during the 021G-3 cutover.
//
// An app setting is mutable from outside the artefact, so it can never be
// evidence about the artefact. This module reads provenance that was written
// INSIDE the package at build time and is therefore immutable once deployed:
// change the code and you necessarily get a different package, hence a different
// fingerprint. A worker running a stale mount reports the stale fingerprint no
// matter what the app setting says.
//
// Read once and cached: this is on the health path and must not do file I/O per
// request. A missing or unreadable file yields nulls, which the guard treats as a
// FAILURE — absent provenance must never look like matching provenance.
// ============================================================
import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface PackageProvenance {
  /** Git SHA captured at build time, from inside the package. */
  packageSha: string | null;
  /** Next.js BUILD_ID — regenerated on every build, so it fingerprints the
   *  artefact even if two builds share a git SHA. */
  packageBuildId: string | null;
  builtAt: string | null;
}

const MISSING: PackageProvenance = { packageSha: null, packageBuildId: null, builtAt: null };
let cached: PackageProvenance | null = null;

function readJson(file: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; }
  catch { return null; }
}

export function packageProvenance(): PackageProvenance {
  if (cached) return cached;
  // The standalone server runs with cwd = the deployed root, which is where the
  // packaging step places watson-build.json. The alternatives cover `next start`
  // from a repo checkout and a nested standalone layout.
  const roots = [process.cwd(), path.join(process.cwd(), '.next', 'standalone')];
  for (const root of roots) {
    const p = readJson(path.join(root, 'watson-build.json'));
    if (p && typeof p.sha === 'string') {
      cached = {
        packageSha: p.sha,
        packageBuildId: typeof p.buildId === 'string' ? p.buildId : null,
        builtAt: typeof p.builtAt === 'string' ? p.builtAt : null
      };
      return cached;
    }
  }
  // Fall back to BUILD_ID alone: it still fingerprints the artefact, so a stale
  // mount is still detectable even if the provenance file went missing.
  for (const root of roots) {
    try {
      const id = readFileSync(path.join(root, '.next', 'BUILD_ID'), 'utf8').trim();
      if (id) { cached = { packageSha: null, packageBuildId: id, builtAt: null }; return cached; }
    } catch { /* try the next root */ }
  }
  cached = MISSING;
  return cached;
}

/** Test seam: provenance is cached deliberately, so tests must be able to clear it. */
export function __resetPackageProvenanceCache(): void { cached = null; }
