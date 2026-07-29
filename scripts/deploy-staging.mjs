#!/usr/bin/env node
/* ============================================================
 * Watson — 021E : staging deployment guard.
 * Run: node scripts/deploy-staging.mjs [--dry-run] [--skip-tests]
 * ------------------------------------------------------------
 * 021D deployed a STALE bundle and reported success. Two distinct failures made
 * that possible, and this script exists to make both impossible:
 *
 *   1. The artifact was packaged from a .next directory built BEFORE the last
 *      source edit. `az webapp deploy` happily shipped it and returned
 *      RuntimeSuccessful, because "the package uploaded" and "the package is
 *      correct" are different claims.
 *   2. Azure run-from-package mounts a new zip but the RUNNING WORKER keeps
 *      serving the old one until it is restarted. The deployment was accepted
 *      while the old code was still live — "deployment accepted" and
 *      "deployment active" are different claims too.
 *
 * The order below is therefore mandatory, every step aborts on failure, and the
 * final verdict is machine-readable. Nothing here prints a secret: app settings
 * are written with output suppressed and never read back wholesale.
 * ============================================================ */
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const APP = 'watson-pilot-hrnp01';
const RG = 'watson-nonprod-rg';
const HEALTH = `https://${APP}.azurewebsites.net/api/health`;
const DRY = process.argv.includes('--dry-run');
const SKIP_TESTS = process.argv.includes('--skip-tests');

const steps = [];
let failed = null;

function step(name, fn) {
  if (failed) { steps.push({ name, status: 'skipped' }); return undefined; }
  process.stdout.write(`\n[deploy] ${name}\n`);
  try {
    const detail = fn();
    steps.push({ name, status: 'ok', detail: detail ?? null });
    return detail;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    steps.push({ name, status: 'failed', detail: message.slice(0, 300) });
    failed = `${name}: ${message.slice(0, 300)}`;
    return undefined;
  }
}
const sh = (cmd, opts = {}) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const fail = (m) => { throw new Error(m); };

// ---------------------------------------------------------------- 1. source
const sha = step('verify clean intended source', () => {
  const dirty = sh('git status --porcelain');
  if (dirty) fail(`working tree has uncommitted changes:\n${dirty.slice(0, 300)}`);
  const head = sh('git rev-parse HEAD');
  const branch = sh('git rev-parse --abbrev-ref HEAD');
  if (branch !== 'feature/watson-admin-rbac-management-021') {
    fail(`refusing to deploy from branch "${branch}"`);
  }
  let remote = '';
  try { remote = sh(`git rev-parse origin/${branch}`); } catch { /* not pushed yet */ }
  if (remote && remote !== head) fail('local HEAD does not match the pushed remote branch');
  return { head, branch };
});

// ---------------------------------------------------------------- 2. deps
step('install dependencies', () => { sh('npm ci'); return 'npm ci'; });

// ---------------------------------------------------------------- 3. validate
step('run tests and static validation', () => {
  if (SKIP_TESTS) return 'skipped by flag';
  sh('npm run it-agent:selftest');
  sh('npx tsc --noEmit');
  sh('npm run lint');
  sh('npm run verify:config');
  return 'selftest + tsc + lint + verify:config';
});

// ---------------------------------------------------------------- 4. build
// Deleting .next first is what makes step 5 meaningful: a build that cannot be
// stale is better than a check that hopes it is not.
step('build from the current source (stale .next removed first)', () => {
  fs.rmSync(path.join(process.cwd(), '.next'), { recursive: true, force: true });
  sh('npm run build');
  if (!fs.existsSync('.next/standalone/server.js')) fail('standalone build output missing');
  return 'clean build';
});

// ------------------------------------------------- 5. build matches this SHA
step('verify the build corresponds to the current source', () => {
  const buildTime = fs.statSync('.next/standalone/server.js').mtimeMs;
  // Every tracked source file must be OLDER than the build output. This is the
  // check that would have caught 021D.
  const tracked = sh('git ls-files src scripts package.json next.config.mjs').split('\n').filter(Boolean);
  const newer = tracked.filter((f) => {
    try { return fs.statSync(f).mtimeMs > buildTime + 1000; } catch { return false; }
  });
  if (newer.length) fail(`source newer than build output (stale build): ${newer.slice(0, 5).join(', ')}`);
  return `${tracked.length} tracked sources older than build`;
});

// ---------------------------------------------------------------- 6. package
const pkg = step('package the verified build', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'watson-pkg-'));
  fs.cpSync('.next/standalone', out, { recursive: true });
  fs.mkdirSync(path.join(out, '.next'), { recursive: true });
  fs.cpSync('.next/static', path.join(out, '.next', 'static'), { recursive: true });
  if (fs.existsSync('public')) fs.cpSync('public', path.join(out, 'public'), { recursive: true });
  const zip = path.join(os.tmpdir(), `watson-${sha?.head?.slice(0, 12) ?? 'build'}.zip`);
  fs.rmSync(zip, { force: true });
  // MUST be pwsh (PowerShell 7 / .NET Core), never `powershell` (5.1 / .NET
  // Framework). .NET Framework's ZipFile writes OS-NATIVE separators, producing
  // entry names like `.next\server\page.js`. The zip spec requires forward
  // slashes, so on Linux App Service every file extracts as one flat filename
  // instead of a directory tree and the container exits 1 at startup. That is
  // exactly how this script took staging down on its first run.
  execFileSync('pwsh', ['-NoProfile', '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${out}','${zip}','Optimal',$false)`
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  return { dir: out, zip };
});

// ------------------------------------------- 7. package contents are correct
step('verify package contents and absence of runtime state', () => {
  const dir = pkg.dir;
  if (!fs.existsSync(path.join(dir, 'server.js'))) fail('package is missing server.js');
  if (!fs.existsSync(path.join(dir, '.next', 'static'))) fail('package is missing .next/static');
  // The JSON runtime store must never ship: with WATSON_DATA_DIR unset the app
  // falls back to <cwd>/data, so a bundled store could promote synthetic role
  // assignments into a real environment.
  const forbidden = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name === 'data' && path.dirname(full) === dir) forbidden.push(full); walk(full); }
      else if (e.name === 'watson-store.json') forbidden.push(full);
    }
  };
  walk(dir);
  if (forbidden.length) fail(`runtime store bundled: ${forbidden.map((f) => path.relative(dir, f)).join(', ')}`);

  // Inspect the ZIP ITSELF, not just the staging directory. A directory can look
  // perfect while the archive built from it is unusable — which is precisely the
  // failure that took staging down: correct files, backslash entry names, and a
  // container that could not start. Checking the artifact that actually ships is
  // the only check that would have caught it.
  const listing = execFileSync('pwsh', ['-NoProfile', '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
    `$z=[System.IO.Compression.ZipFile]::OpenRead('${pkg.zip}'); ` +
    `$z.Entries | ForEach-Object { $_.FullName }; $z.Dispose()`
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').map((s) => s.trim()).filter(Boolean);

  const backslashed = listing.filter((n) => n.includes('\\'));
  if (backslashed.length) {
    fail(`zip entry names use backslashes (unusable on Linux): ${backslashed.slice(0, 3).join(', ')}`);
  }
  for (const required of ['server.js', '.next/BUILD_ID', '.next/routes-manifest.json']) {
    if (!listing.includes(required)) fail(`zip is missing a required entry: ${required}`);
  }
  if (!listing.some((n) => n.startsWith('.next/static/'))) fail('zip contains no .next/static assets');
  if (listing.some((n) => n.startsWith('data/') || n.endsWith('/watson-store.json'))) {
    fail('zip contains a runtime store');
  }
  return `${listing.length} zip entries verified, forward-slash paths, no runtime store`;
});

// ---------------------------------------------------------------- 8. deploy
const deployment = step('deploy the package', () => {
  if (DRY) return 'dry-run: not deployed';
  // Provenance is written BEFORE the deploy so the app can never advertise a SHA
  // for code it is not serving; step 11 then proves the two agree.
  execSync(`az webapp config appsettings set -n ${APP} -g ${RG} --settings WATSON_DEPLOYED_SHA=${sha.head}`,
    { stdio: 'ignore' });
  const out = sh(`az webapp deploy --resource-group ${RG} --name ${APP} --src-path "${pkg.zip}" --type zip --async false`);
  const m = out.match(/"deploymentId":\s*"([^"]+)"/);
  if (!/RuntimeSuccessful/.test(out)) fail('deployment did not report RuntimeSuccessful');
  return { deploymentId: m ? m[1] : 'unknown', accepted: true };
});

// ------------------------------------- 9. remount (run-from-package requires)
step('restart to remount the package', () => {
  if (DRY) return 'dry-run: not restarted';
  // WEBSITE_RUN_FROM_PACKAGE mounts the new zip but the running worker keeps
  // serving the previous one until it is restarted. Without this the next step
  // would poll a worker that can never converge.
  execSync(`az webapp restart -n ${APP} -g ${RG}`, { stdio: 'ignore' });
  return 'restarted';
});

// ------------------------------------------- 10/11. poll until ACTIVE + exact
const served = step('poll until the worker serves the expected SHA', () => {
  if (DRY) return 'dry-run: not polled';
  const deadline = Date.now() + 300_000;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const body = sh(`curl -s --max-time 15 ${HEALTH}`);
      const h = JSON.parse(body);
      last = h;
      if (h.commit === sha.head) return h;
    } catch { /* worker still starting */ }
    execSync('powershell -NoProfile -Command "Start-Sleep -Seconds 5"', { stdio: 'ignore' });
  }
  fail(`served SHA never converged. last=${JSON.stringify(last).slice(0, 200)}`);
});

// -------------------------------------------------- 12. authenticated posture
step('verify deployed posture', () => {
  if (DRY) return 'dry-run: not verified';
  if (served.commit !== sha.head) fail(`served ${served.commit} != package ${sha.head}`);
  if (served.environment !== 'staging-021c2') fail(`unexpected environment ${served.environment}`);
  if (served.liveExecutionEnabled !== false) fail('live execution is enabled — refusing to accept this deployment');
  // Easy Auth must still reject anonymous access to a privileged route.
  const code = sh(`curl -s -o /dev/null -w "%{http_code}" --max-time 25 https://${APP}.azurewebsites.net/admin/access-and-roles`);
  if (code !== '401') fail(`anonymous access to the admin page returned ${code}, expected 401`);
  return { authMode: served.authMode, liveRead: served.liveReadGateEnabled, liveExec: served.liveExecutionEnabled, anonymous: code };
});

// ---------------------------------------------------------------- verdict
const result = {
  task: 'watson-staging-deploy',
  ok: !failed,
  // These two are deliberately separate claims.
  deploymentAccepted: steps.find((s) => s.name === 'deploy the package')?.status === 'ok',
  deploymentActive: steps.find((s) => s.name === 'poll until the worker serves the expected SHA')?.status === 'ok',
  expectedSha: sha?.head ?? null,
  servedSha: served?.commit ?? null,
  shaMatch: Boolean(sha?.head && served?.commit && sha.head === served.commit),
  deploymentId: deployment?.deploymentId ?? null,
  environment: served?.environment ?? null,
  failure: failed,
  steps
};
console.log('\n' + JSON.stringify(result, null, 2));
process.exit(failed ? 1 : 0);
