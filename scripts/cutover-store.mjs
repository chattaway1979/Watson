#!/usr/bin/env node
/* ============================================================
 * Watson — 021G-3 : SAFE RBAC store cutover.
 * Run: node scripts/cutover-store.mjs --to postgres|json [--final-workers N] [--dry-run]
 * ------------------------------------------------------------
 * THE DEFECT THIS EXISTS TO PREVENT
 * Changing WATSON_RBAC_STORE on a multi-worker App Service triggers a ROLLING
 * restart. During the roll the workers do not switch together: for 1-2 minutes
 * one worker served json_legacy while the other served postgres. That was
 * observed directly during the 021G-3 cutover.
 *
 * That window is not cosmetic. Two workers on two different stores are two
 * different RBAC worlds: a role granted on one is invisible to the other, a
 * preview nonce issued on one cannot be consumed on the other, and — worst —
 * final-administrator protection counts administrators in whichever store the
 * worker happens to be using, so two concurrent removals could each believe an
 * administrator remained. A store switch is therefore only safe while exactly
 * ONE worker is running.
 *
 * The procedure, in this order, no step skippable:
 *   1. refuse outright if more than one worker is active and this is not an
 *      explicit single-worker transition;
 *   2. scale to one worker;
 *   3. wait for convergence on one worker;
 *   4. change WATSON_RBAC_STORE;
 *   5. restart to remount;
 *   6. verify the sole worker reports the intended store AND the expected
 *      package-embedded SHA (an app setting is not evidence — see
 *      build-provenance.ts);
 *   7. only then scale back up;
 *   8. verify every worker agrees before RBAC mutations are permitted.
 *
 * It prints a machine-readable verdict and never prints a secret.
 * ============================================================ */
import { execSync } from 'node:child_process';

const APP = 'watson-pilot-hrnp01';
const RG = 'watson-nonprod-rg';
const PLAN = 'watson-nonprod-plan';
const HEALTH = `https://${APP}.azurewebsites.net/api/health`;

const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const TARGET = argOf('--to');
const FINAL_WORKERS = Number(argOf('--final-workers', '2'));
const DRY = args.includes('--dry-run');
const FORCE_MULTI = args.includes('--i-accept-a-mixed-store-window');

const steps = [];
let failed = null;
function step(name, fn) {
  if (failed) { steps.push({ name, status: 'skipped' }); return undefined; }
  process.stdout.write(`\n[cutover] ${name}\n`);
  try { const detail = fn(); steps.push({ name, status: 'ok', detail: detail ?? null }); return detail; }
  catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    steps.push({ name, status: 'failed', detail: m.slice(0, 300) });
    failed = `${name}: ${m.slice(0, 300)}`;
    return undefined;
  }
}
const sh = (c) => execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const fail = (m) => { throw new Error(m); };
const sleep = (s) => execSync(`powershell -NoProfile -Command "Start-Sleep -Seconds ${s}"`, { stdio: 'ignore' });

const EXPECTED_STORE = { postgres: 'postgres', json: 'json_legacy' };

function health(tag) {
  return JSON.parse(sh(`curl -s --max-time 25 "${HEALTH}?cutover=${tag}-${Date.now()}"`));
}
function instanceCount() {
  const n = Number(sh(`az webapp list-instances -n ${APP} -g ${RG} --query "length(@)" -o tsv`));
  if (!Number.isFinite(n) || n < 1) fail('could not determine the active worker count');
  return n;
}
/** Poll until `wanted` distinct workers have been observed and all satisfy `ok`. */
function converge(wanted, ok, label, budgetMs = 420_000) {
  const deadline = Date.now() + budgetMs;
  let seen = new Map(); let last = null;
  while (Date.now() < deadline) {
    try {
      const h = health(label); last = h;
      seen.set(h.workerId ?? 'unknown', h);
      if (seen.size >= wanted && [...seen.values()].every(ok)) return { workers: [...seen.keys()], body: last };
      for (const [k, v] of [...seen]) if (!ok(v)) seen.delete(k);
    } catch { /* restarting */ }
    sleep(5);
  }
  fail(`${label}: never converged. wanted=${wanted} observed=${[...seen.keys()].join(',') || 'none'} last=${JSON.stringify(last).slice(0, 250)}`);
}

// ------------------------------------------------------------------ 0. inputs
const expectedSha = step('validate inputs and read the expected package fingerprint', () => {
  if (!TARGET || !EXPECTED_STORE[TARGET]) fail('--to must be postgres or json');
  if (!Number.isFinite(FINAL_WORKERS) || FINAL_WORKERS < 1) fail('--final-workers must be >= 1');
  const head = sh('git rev-parse HEAD');
  // A cutover is a CONFIGURATION change, not a deployment, so what must be true
  // is that the running package corresponds to the committed source — its SHA.
  // BUILD_ID is deliberately NOT required to match a local build: Next.js mints a
  // new BUILD_ID on every build, so an unrelated local rebuild would otherwise
  // make a perfectly healthy cutover fail. BUILD_ID is the right fingerprint
  // inside a deploy (where the artefact being checked IS the one just built) and
  // the wrong one here. It can still be pinned explicitly when a caller knows the
  // exact artefact it expects.
  const explicitBuildId = argOf('--expect-build-id', null);
  return { target: TARGET, expectedStore: EXPECTED_STORE[TARGET], head,
    packageSha: head, packageBuildId: explicitBuildId, finalWorkers: FINAL_WORKERS };
});

// ------------------------------------------------- 1. refuse an unsafe switch
step('refuse a store switch while multiple workers are active', () => {
  if (DRY) return 'dry-run: not checked';
  const n = instanceCount();
  if (n > 1 && FORCE_MULTI) {
    // Escape hatch exists so an operator can make an informed choice, but it is
    // recorded loudly rather than being a quiet default.
    return { activeWorkers: n, decision: 'PROCEEDING WITH A KNOWN MIXED-STORE WINDOW (explicitly overridden)' };
  }
  if (n > 1) {
    return { activeWorkers: n, decision: 'unsafe — will scale to one worker first (step 2)' };
  }
  return { activeWorkers: n, decision: 'already single-worker' };
});

// ---------------------------------------------------------- 2/3. single worker
step('scale to one worker and wait for convergence', () => {
  if (DRY) return 'dry-run: not scaled';
  if (FORCE_MULTI) return 'skipped: mixed-store window explicitly accepted';
  sh(`az appservice plan update -g ${RG} -n ${PLAN} --number-of-workers 1 -o none`);
  sh(`az webapp config set -n ${APP} -g ${RG} --number-of-workers 1 -o none`);
  sleep(30);
  // Convergence means ONE worker answering, repeatedly — not merely one ARM
  // instance record. A draining worker can still serve requests.
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const ids = new Set();
    for (let i = 0; i < 8; i++) { try { ids.add(health('scaledown').workerId); } catch { /* restarting */ } sleep(2); }
    if (ids.size === 1 && instanceCount() === 1) return { soleWorker: [...ids][0] };
    sleep(5);
  }
  fail('the app never converged to a single answering worker');
});

// --------------------------------------------------------- 4/5. switch + remount
step('change WATSON_RBAC_STORE and remount', () => {
  if (DRY) return `dry-run: would set WATSON_RBAC_STORE=${TARGET}`;
  sh(`az webapp config appsettings set -n ${APP} -g ${RG} --settings WATSON_RBAC_STORE=${TARGET} -o none`);
  // An app-settings change restarts the app, but WEBSITE_RUN_FROM_PACKAGE also
  // needs a remount for any package change to take effect, and an explicit
  // restart is what makes convergence observable rather than assumed.
  sh(`az webapp restart -n ${APP} -g ${RG}`);
  sleep(25);
  return `WATSON_RBAC_STORE=${TARGET}`;
});

// ------------------------------------------- 6. verify store AND package sha
const verified = step('verify the sole worker reports the intended store and package SHA', () => {
  if (DRY) return 'dry-run: not verified';
  const want = EXPECTED_STORE[TARGET];
  const r = converge(1, (h) =>
    h.rbacStore === want &&
    h.packageCommit === expectedSha.packageSha &&
    (!expectedSha.packageBuildId || h.packageBuildId === expectedSha.packageBuildId) &&
    h.rbacStoreReachable !== false, 'verify-single');
  const h = r.body;
  if (TARGET === 'postgres' && h.rbacStoreMultiInstanceSafe !== true) {
    fail('postgres is active but the worker does not report multiInstanceSafe');
  }
  return { worker: h.workerId, store: h.rbacStore, packageSha: h.packageCommit,
    packageBuildId: h.packageBuildId, reachable: h.rbacStoreReachable,
    multiInstanceSafe: h.rbacStoreMultiInstanceSafe };
});

// ------------------------------------------------------------- 7. scale back up
step(`scale back to ${FINAL_WORKERS} worker(s)`, () => {
  if (DRY) return 'dry-run: not scaled';
  if (FINAL_WORKERS === 1) return 'final worker count is 1 — nothing to scale';
  sh(`az appservice plan update -g ${RG} -n ${PLAN} --number-of-workers ${FINAL_WORKERS} -o none`);
  sh(`az webapp config set -n ${APP} -g ${RG} --number-of-workers ${FINAL_WORKERS} -o none`);
  sleep(45);
  return `scaled to ${FINAL_WORKERS}`;
});

// --------------------------------- 8. every worker agrees before mutations
step('verify every worker agrees on store and package before permitting mutations', () => {
  if (DRY) return 'dry-run: not verified';
  const want = EXPECTED_STORE[TARGET];
  const r = converge(FINAL_WORKERS, (h) =>
    h.rbacStore === want && h.packageCommit === expectedSha.packageSha, 'verify-all');
  // Belt and braces: sample again and require unanimity, so a worker that was
  // merely slow to appear cannot be missed.
  const bodies = [];
  for (let i = 0; i < Math.max(10, FINAL_WORKERS * 6); i++) { try { bodies.push(health('unanimity')); } catch { /* transient */ } }
  const stores = [...new Set(bodies.map((b) => b.rbacStore))];
  const pkgs = [...new Set(bodies.map((b) => b.packageCommit))];
  const ids = [...new Set(bodies.map((b) => b.workerId))];
  if (stores.length !== 1 || stores[0] !== want) fail(`workers disagree on the store: ${JSON.stringify(stores)}`);
  if (pkgs.length !== 1) fail(`workers disagree on the package: ${JSON.stringify(pkgs)}`);
  if (ids.length < FINAL_WORKERS) fail(`only observed ${ids.length} of ${FINAL_WORKERS} workers: ${JSON.stringify(ids)}`);
  return { workersObserved: ids, store: stores[0], packageSha: pkgs[0], mutationsPermitted: true, converged: r.workers };
});

const result = {
  task: 'watson-rbac-store-cutover',
  ok: !failed,
  target: TARGET,
  expectedStore: EXPECTED_STORE[TARGET] ?? null,
  finalWorkers: FINAL_WORKERS,
  singleWorkerTransition: !FORCE_MULTI,
  mixedStoreWindowAccepted: FORCE_MULTI,
  verified: verified ?? null,
  failure: failed,
  steps
};
console.log('\n' + JSON.stringify(result, null, 2));
process.exit(failed ? 1 : 0);
