// ============================================================
// Watson — 021G-3 : write build provenance INSIDE the package.
// ------------------------------------------------------------
// Runs immediately after `next build`. Writes watson-build.json into the
// standalone output root, which is what gets zipped and mounted, so the running
// worker can report a fingerprint that no app setting can forge.
//
// The git SHA is captured here rather than passed in, so the provenance
// describes the tree the build was made from and cannot be overridden by a
// caller who merely claims a SHA.
// ============================================================
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const standalone = path.join(root, '.next', 'standalone');
const buildIdFile = path.join(root, '.next', 'BUILD_ID');

if (!existsSync(buildIdFile)) {
  console.error('write-build-provenance: .next/BUILD_ID is missing — run next build first');
  process.exit(1);
}
const buildId = readFileSync(buildIdFile, 'utf8').trim();

let sha = 'unknown';
let dirty = true;
try {
  sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  dirty = execSync('git status --porcelain --untracked-files=no', { encoding: 'utf8' }).trim().length > 0;
} catch {
  // A build outside a git checkout still gets a BUILD_ID fingerprint, which is
  // enough to detect a stale mount even without a SHA.
}

const provenance = {
  sha,
  buildId,
  builtAt: new Date().toISOString(),
  // Recorded honestly: a package built from a dirty tree is not reproducible
  // from its SHA, and the guard refuses to deploy one anyway.
  sourceDirtyAtBuild: dirty
};
const body = JSON.stringify(provenance, null, 2) + '\n';

// The standalone root is the deployed root.
if (!existsSync(standalone)) mkdirSync(standalone, { recursive: true });
writeFileSync(path.join(standalone, 'watson-build.json'), body, 'utf8');
// Also at the repo build root so `next start` from a checkout reports the same.
writeFileSync(path.join(root, '.next', 'watson-build.json'), body, 'utf8');
writeFileSync(path.join(root, 'watson-build.json'), body, 'utf8');

console.log(`build provenance: sha=${sha.slice(0, 12)} buildId=${buildId} dirty=${dirty}`);
