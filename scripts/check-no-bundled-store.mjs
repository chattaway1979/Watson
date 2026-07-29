/* ============================================================
 * Watson — 021C-2 : standalone package hygiene gate.
 * Run: node scripts/check-no-bundled-store.mjs   (wired into `npm run build`)
 * ------------------------------------------------------------
 * Staging found that Next's standalone file tracing had copied the developer's
 * LOCAL runtime store (`data/watson-store.json`) into `.next/standalone/`, so a
 * deployment artifact carried synthetic RBAC state — including an active
 * `watson_role_admin` assignment for a synthetic object id.
 *
 * On the deployed app `WATSON_DATA_DIR=/home/data`, so the bundled copy was not
 * the file being read. But the store path falls back to `<cwd>/data` whenever
 * WATSON_DATA_DIR is absent, which means a single missing app setting would have
 * promoted a synthetic administrator into a real environment. A build must never
 * be able to ship that.
 *
 * This gate fails the build. It is deliberately not a warning.
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const STANDALONE = path.join(ROOT, '.next', 'standalone');

// Any of these inside the standalone output is a packaging defect.
const FORBIDDEN_FILES = ['watson-store.json'];
const FORBIDDEN_DIRS = ['data'];

/** Walk the standalone output, skipping node_modules (third-party fixtures there
 *  are not our runtime store and would only create noise). */
function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { out.push({ full, dir: true, name: e.name }); walk(full, out); }
    else out.push({ full, dir: false, name: e.name });
  }
  return out;
}

if (!fs.existsSync(STANDALONE)) {
  console.log('[watson] package gate: no standalone output to check (skipped).');
  process.exit(0);
}

const found = walk(STANDALONE);
const offenders = found.filter((f) =>
  (!f.dir && FORBIDDEN_FILES.includes(f.name)) ||
  (f.dir && FORBIDDEN_DIRS.includes(f.name) && path.dirname(f.full) === STANDALONE)
);

if (offenders.length) {
  console.error('\n[watson] PACKAGE GATE FAILED — a local runtime store was bundled into the deployment artifact:\n');
  for (const o of offenders) {
    console.error('  ' + path.relative(ROOT, o.full) + (o.dir ? '  (directory)' : ''));
  }
  console.error('\nShipping a local store can promote synthetic role assignments into a real');
  console.error('environment if WATSON_DATA_DIR is ever unset. Remove it from the build output');
  console.error('(and keep the runtime store outside the project root) before deploying.\n');
  process.exit(1);
}

console.log('[watson] package gate: no local runtime store bundled in .next/standalone.');
process.exit(0);
