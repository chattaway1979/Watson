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
 *   3. (021G-3) The convergence check itself was hollow. It compared health's
 *      `commit` against the expected SHA, but `commit` came from the
 *      WATSON_DEPLOYED_SHA app setting that THIS SCRIPT writes before it
 *      restarts. So it validated its own bookkeeping, not the running bundle,
 *      and reported "deployment active" while the previous package was still
 *      answering requests. Observed repeatedly during the 021G-3 cutover: new
 *      code only ran after an extra manual restart.
 *
 *      The fix: convergence is judged on PACKAGE-EMBEDDED provenance
 *      (watson-build.json + .next/BUILD_ID, written into the artefact at build
 *      time and immutable once deployed), and EVERY active worker must report
 *      it. An app setting is mutable from outside the artefact, so it can never
 *      be evidence about the artefact.
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
  // 021G-3: the app-setting SHA is NOT written here. It used to be, with a comment
  // claiming that stopped the app advertising a SHA for code it was not serving —
  // exactly backwards. Writing it before the remount is what CREATED that window:
  // health reported the new SHA while the old package answered. It is now written
  // only after every worker has been proven to run the new package, so the setting
  // can never be ahead of the artefact.
  const out = sh(`az webapp deploy --resource-group ${RG} --name ${APP} --src-path "${pkg.zip}" --type zip --async false`);
  const m = out.match(/"deploymentId":\s*"([^"]+)"/);
  // `az webapp deploy` does not always echo RuntimeSuccessful even when the
  // deployment succeeds, so a missing string is not evidence of failure. Confirm
  // against the deployments API, which is authoritative, before giving up.
  if (!/RuntimeSuccessful/.test(out)) {
    let confirmed = false;
    for (let i = 0; i < 12 && !confirmed; i++) {
      try {
        const list = JSON.parse(sh(`az rest --method GET --uri "https://${APP}.scm.azurewebsites.net/api/deployments?$top=1" --resource https://management.core.windows.net/`));
        const d = Array.isArray(list) ? list[0] : null;
        // status 4 == Success in the Kudu deployment model.
        if (d && d.complete === true && Number(d.status) === 4) confirmed = true;
      } catch { /* SCM may be restarting */ }
      if (!confirmed) execSync('powershell -NoProfile -Command "Start-Sleep -Seconds 5"', { stdio: 'ignore' });
    }
    if (!confirmed) fail('deployment reported neither RuntimeSuccessful nor a successful deployment record');
    return { deploymentId: m ? m[1] : 'unknown', accepted: true, confirmedVia: 'deployments-api' };
  }
  return { deploymentId: m ? m[1] : 'unknown', accepted: true, confirmedVia: 'runtime-successful' };
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

// --------------------------------- 10/11. poll until ACTIVE on the PACKAGE sha
// The expected fingerprint comes from the artefact that was just built, NOT from
// anything this script asserts about itself.
const expected = step('read the package-embedded fingerprint from the built artefact', () => {
  const f = path.join(process.cwd(), '.next', 'standalone', 'watson-build.json');
  if (!fs.existsSync(f)) fail('watson-build.json missing from the standalone build - provenance was not generated');
  const prov = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (prov.sha !== sha.head) fail(`package provenance sha ${prov.sha} != HEAD ${sha.head}`);
  if (!prov.buildId) fail('package provenance carries no buildId');
  if (prov.sourceDirtyAtBuild) fail('the package was built from a dirty tree');
  return { packageSha: prov.sha, packageBuildId: prov.buildId };
});

function activeWorkerCount() {
  try {
    const n = Number(sh(`az webapp list-instances -n ${APP} -g ${RG} --query "length(@)" -o tsv`));
    return Number.isFinite(n) && n > 0 ? n : 1;
  } catch { return 1; }
}

// Requires EVERY active worker to report the package-embedded fingerprint.
// Polling once and believing the answer is what let a stale worker pass: with two
// workers one can be current while the other still serves the old mount, and a
// single request has a 50% chance of asking the wrong one.
const served = step('poll every active worker for the package-embedded fingerprint', () => {
  if (DRY) return 'dry-run: not polled';
  const wanted = activeWorkerCount();
  const deadline = Date.now() + 420_000;
  const seen = new Map();
  let last = null;
  while (Date.now() < deadline) {
    try {
      const h = JSON.parse(sh(`curl -s --max-time 20 "${HEALTH}?probe=${Date.now()}"`));
      last = h;
      seen.set(h.workerId ?? 'unknown', h);
      const matches = (x) => x.packageCommit === expected.packageSha && x.packageBuildId === expected.packageBuildId;
      if (seen.size >= wanted && [...seen.values()].every(matches)) {
        return { workers: seen.size, expectedWorkers: wanted, ids: [...seen.keys()], body: last };
      }
      // A worker matching the app setting but NOT the package IS the stale-bundle
      // condition. Forget it so a later poll can re-observe it once restarted;
      // never accept it.
      for (const [k, v] of [...seen]) if (!matches(v)) seen.delete(k);
    } catch { /* worker still starting */ }
    execSync('powershell -NoProfile -Command "Start-Sleep -Seconds 5"', { stdio: 'ignore' });
  }
  fail(`not every worker converged on the package fingerprint. wanted=${wanted} observed=${[...seen.keys()].join(',') || 'none'} last=${JSON.stringify(last).slice(0, 300)}`);
});

// A separate, explicit claim: workers agree with EACH OTHER and with the
// artefact. Disagreement is its own failure, not something to retry away.
step('verify all workers agree on the package fingerprint', () => {
  if (DRY) return 'dry-run: not verified';
  const bodies = [];
  const n = Math.max(8, (served.expectedWorkers ?? 1) * 5);
  for (let i = 0; i < n; i++) {
    try { bodies.push(JSON.parse(sh(`curl -s --max-time 20 "${HEALTH}?agree=${i}-${Date.now()}"`))); } catch { /* transient */ }
  }
  if (!bodies.length) fail('no worker answered the agreement check');
  const buildIds = [...new Set(bodies.map((b) => b.packageBuildId))];
  const commits = [...new Set(bodies.map((b) => b.packageCommit))];
  const stores = [...new Set(bodies.map((b) => b.rbacStore))];
  if (buildIds.length !== 1) fail(`workers disagree on packageBuildId: ${JSON.stringify(buildIds)}`);
  if (commits.length !== 1) fail(`workers disagree on packageCommit: ${JSON.stringify(commits)}`);
  if (buildIds[0] !== expected.packageBuildId) fail(`workers serve packageBuildId ${buildIds[0]}, expected ${expected.packageBuildId}`);
  if (stores.length !== 1) fail(`workers disagree on the active RBAC store: ${JSON.stringify(stores)}`);
  return { distinctWorkers: [...new Set(bodies.map((b) => b.workerId))], packageBuildId: buildIds[0], store: stores[0] };
});

// ----------------------------- 11b. bookkeeping AFTER the package is proven live
// Deliberately last. This setting is convenience metadata, not evidence: it is
// mutable from outside the artefact, and writing it before the remount is what
// produced the stale-bundle false pass in the first place.
step('record the deployed SHA app setting (after convergence)', () => {
  if (DRY) return 'dry-run: not recorded';
  execSync(`az webapp config appsettings set -n ${APP} -g ${RG} --settings WATSON_DEPLOYED_SHA=${sha.head}`,
    { stdio: 'ignore' });
  // Changing an app setting restarts the app, so convergence on the PACKAGE has
  // to be re-established before the posture check reads health again.
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    try {
      const h = JSON.parse(sh(`curl -s --max-time 20 "${HEALTH}?rec=${Date.now()}"`));
      if (h.packageCommit === sha.head && h.commit === sha.head) return { appSettingSha: h.commit, packageSha: h.packageCommit };
    } catch { /* restarting */ }
    execSync('powershell -NoProfile -Command "Start-Sleep -Seconds 5"', { stdio: 'ignore' });
  }
  fail('the app setting was recorded but the app did not settle with both SHAs matching');
});

// -------------------------------------------------- 12. authenticated posture
const posture = step('verify deployed posture', () => {
  if (DRY) return 'dry-run: not verified';
  // Re-read: recording the app setting restarted the app, so `served.body` is a
  // pre-restart observation and must not be reused as the final posture.
  const h = JSON.parse(sh(`curl -s --max-time 25 "${HEALTH}?posture=${Date.now()}"`));
  // Both are checked and they are NOT the same claim. The package fingerprint is
  // the one that proves which code is running.
  if (h.packageCommit !== sha.head) fail(`running package ${h.packageCommit} != HEAD ${sha.head}`);
  if (h.commit !== sha.head) fail(`app-setting SHA ${h.commit} != HEAD ${sha.head}`);
  if (h.environment !== 'staging-021c2') fail(`unexpected environment ${h.environment}`);
  if (h.liveExecutionEnabled !== false) fail('live execution is enabled — refusing to accept this deployment');
  // Easy Auth must still reject anonymous access to a privileged route.
  // Retried: a transient curl/network failure during the post-restart settle is
  // not an access-control finding, and treating it as one fails a good rollout.
  // What must never be tolerated is a NON-401 answer, which is a real finding.
  let code = null;
  for (let i = 0; i < 6; i++) {
    try { code = sh(`curl -s -o /dev/null -w "%{http_code}" --max-time 25 https://${APP}.azurewebsites.net/admin/access-and-roles`); } catch { code = null; }
    if (code === '401') break;
    if (code && code !== '401') fail(`anonymous access to the admin page returned ${code}, expected 401`);
    execSync('powershell -NoProfile -Command "Start-Sleep -Seconds 5"', { stdio: 'ignore' });
  }
  if (code !== '401') fail('anonymous access check never completed — could not confirm a 401');
  return { authMode: h.authMode, liveRead: h.liveReadGateEnabled, liveExec: h.liveExecutionEnabled,
    anonymous: code, appSettingSha: h.commit, packageSha: h.packageCommit, packageBuildId: h.packageBuildId,
    workerAnswering: h.workerId, rbacStore: h.rbacStore };
});

// ---------------------------------------------------------------- verdict
const result = {
  task: 'watson-staging-deploy',
  ok: !failed,
  // These two are deliberately separate claims.
  deploymentAccepted: steps.find((s) => s.name === 'deploy the package')?.status === 'ok',
  deploymentActive: steps.find((s) => s.name === 'poll every active worker for the package-embedded fingerprint')?.status === 'ok',
  allWorkersAgree: steps.find((s) => s.name === 'verify all workers agree on the package fingerprint')?.status === 'ok',
  expectedSha: sha?.head ?? null,
  // Reported separately on purpose: an app setting is not evidence about the
  // running bundle, and conflating the two is the defect 021G-3 exposed.
  // Taken from the POSTURE step, which re-reads health after the app-setting write
  // restarts the app. `served.body` is a pre-restart observation and would report
  // a stale app-setting SHA here.
  appSettingSha: posture?.appSettingSha ?? served?.body?.commit ?? null,
  packageSha: posture?.packageSha ?? served?.body?.packageCommit ?? null,
  packageBuildId: posture?.packageBuildId ?? served?.body?.packageBuildId ?? null,
  workersObserved: served?.ids ?? null,
  shaMatch: Boolean(sha?.head && posture?.packageSha && sha.head === posture.packageSha),
  deploymentId: deployment?.deploymentId ?? null,
  environment: served?.environment ?? null,
  failure: failed,
  steps
};
console.log('\n' + JSON.stringify(result, null, 2));
process.exit(failed ? 1 : 0);
