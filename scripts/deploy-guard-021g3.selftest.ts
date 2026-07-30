/* ============================================================
 * Watson — 021G-3 : deployment guard and store-cutover safety.
 * Deterministic; NO network, NO Azure, NO database.
 * ------------------------------------------------------------
 * Two defects were found during the 021G-3 cutover. These tests reproduce both
 * as DATA and assert the fixed logic rejects them, so a regression fails here
 * rather than on a live deployment.
 *
 *   A. STALE BUNDLE. The guard proved a rollout live by comparing health's
 *      `commit` to the expected SHA — but `commit` comes from an app setting the
 *      guard itself writes BEFORE restarting. A worker still serving the old
 *      package reported the NEW SHA. The convergence predicate is extracted here
 *      and driven with a worker whose app-setting SHA matches while its package
 *      fingerprint does not: the exact stale condition.
 *
 *   B. MIXED STORE. Changing WATSON_RBAC_STORE with two workers running causes a
 *      rolling restart in which the workers temporarily use DIFFERENT stores —
 *      two RBAC worlds, in which final-administrator protection counts whichever
 *      store its worker happens to hold.
 * ============================================================ */
import { readFileSync } from 'node:fs';

// ------------------------------------------------------------------
// The guard's convergence rule, stated once so it can be tested directly.
// Kept deliberately identical in meaning to scripts/deploy-staging.mjs, and a
// test below pins the script to this definition so they cannot drift apart.
// ------------------------------------------------------------------
export interface WorkerHealth {
  workerId?: string;
  commit?: string | null;          // APP SETTING — mutable from outside the artefact
  packageCommit?: string | null;   // PACKAGE-EMBEDDED — immutable once deployed
  packageBuildId?: string | null;
  rbacStore?: string;
  rbacStoreReachable?: boolean | null;
}
export interface Expected { packageSha: string; packageBuildId: string }

export function workerMatchesPackage(h: WorkerHealth, e: Expected): boolean {
  return h.packageCommit === e.packageSha && h.packageBuildId === e.packageBuildId;
}

/** Deployment is ACTIVE only when every observed worker matches the artefact and
 *  we have observed as many workers as are active. */
export function deploymentActive(observed: WorkerHealth[], e: Expected, activeWorkers: number): boolean {
  const byId = new Map(observed.map((h) => [h.workerId ?? 'unknown', h]));
  if (byId.size < activeWorkers) return false;
  return [...byId.values()].every((h) => workerMatchesPackage(h, e));
}

export function workersAgree(observed: WorkerHealth[]): boolean {
  if (!observed.length) return false;
  return new Set(observed.map((h) => h.packageBuildId)).size === 1 &&
         new Set(observed.map((h) => h.packageCommit)).size === 1;
}

/** A store switch is safe only with exactly one active worker, unless the
 *  operator explicitly accepts a mixed-store window. */
export function storeSwitchPermitted(activeWorkers: number, explicitOverride = false): boolean {
  return activeWorkers === 1 || explicitOverride;
}

export function storesAgree(observed: WorkerHealth[]): boolean {
  if (!observed.length) return false;
  return new Set(observed.map((h) => h.rbacStore)).size === 1;
}

export async function runDeployGuardTests(): Promise<{ pass: number; fail: number; failures: string[] }> {
  let pass = 0, fail = 0; const failures: string[] = [];
  const check = (n: string, c: boolean, d = '') => {
    if (c) { pass++; console.log('  ✅ ' + n); }
    else { fail++; failures.push(n + (d ? ` — ${d}` : '')); console.log('  ❌ ' + n + (d ? ` — ${d}` : '')); }
  };

  const E: Expected = { packageSha: 'aaaa1111', packageBuildId: 'BUILD-NEW' };
  const fresh = (id: string): WorkerHealth => ({
    workerId: id, commit: 'aaaa1111', packageCommit: 'aaaa1111', packageBuildId: 'BUILD-NEW',
    rbacStore: 'postgres', rbacStoreReachable: true
  });
  // THE 021G-3 DEFECT, as data: the app setting was updated before the restart,
  // so this worker claims the new SHA while running the old package.
  const stale = (id: string): WorkerHealth => ({
    workerId: id, commit: 'aaaa1111', packageCommit: 'bbbb2222', packageBuildId: 'BUILD-OLD',
    rbacStore: 'postgres', rbacStoreReachable: true
  });

  console.log('\n[136] Deployment guard — a stale mount cannot be reported as active (021G-3)');
  {
    check('the reproduction case really does match on the app-setting SHA',
      stale('w1').commit === E.packageSha, 'otherwise this test proves nothing');
    check('a stale worker is REJECTED even though WATSON_DEPLOYED_SHA matches',
      workerMatchesPackage(stale('w1'), E) === false);
    check('a fresh worker is accepted', workerMatchesPackage(fresh('w1'), E) === true);
    check('the old rule (app-setting SHA only) WOULD have accepted the stale worker',
      stale('w1').commit === E.packageSha,
      'documents the defect these tests exist to prevent');

    check('one fresh worker of one is active', deploymentActive([fresh('w1')], E, 1) === true);
    check('one stale worker of one is NOT active', deploymentActive([stale('w1')], E, 1) === false);
    check('fresh + stale is NOT active (partial rollout must not pass)',
      deploymentActive([fresh('w1'), stale('w2')], E, 2) === false);
    check('two fresh workers of two are active',
      deploymentActive([fresh('w1'), fresh('w2')], E, 2) === true);
    check('observing only ONE of two active workers is NOT active',
      deploymentActive([fresh('w1')], E, 2) === false,
      'a single poll has a 50% chance of asking the wrong worker');
    check('observing the same worker repeatedly does not count as two',
      deploymentActive([fresh('w1'), fresh('w1'), fresh('w1')], E, 2) === false);
    check('no observations is never active', deploymentActive([], E, 1) === false);

    // A build that shares a git SHA but is a different artefact must still be
    // caught, which is why BUILD_ID is part of the fingerprint.
    const rebuilt: WorkerHealth = { ...fresh('w1'), packageBuildId: 'BUILD-OTHER' };
    check('a different artefact with the SAME git SHA is still rejected',
      workerMatchesPackage(rebuilt, E) === false,
      'BUILD_ID distinguishes two builds of one commit');

    // Absent provenance must never look like matching provenance.
    check('a worker reporting no package provenance is rejected, not trusted',
      workerMatchesPackage({ workerId: 'w1', commit: 'aaaa1111', packageCommit: null, packageBuildId: null }, E) === false);

    check('workers agreeing with each other is asserted separately',
      workersAgree([fresh('w1'), fresh('w2')]) === true);
    check('workers on different packages are reported as disagreeing',
      workersAgree([fresh('w1'), stale('w2')]) === false);
    check('disagreement is detected even when BOTH are wrong',
      workersAgree([stale('w1'), { ...stale('w2'), packageBuildId: 'BUILD-THIRD' }]) === false);
  }

  console.log('\n[137] Deployment guard script — the fix is actually wired in (021G-3)');
  {
    const g = readFileSync('scripts/deploy-staging.mjs', 'utf8');
    check('convergence is judged on the package fingerprint, not the app setting',
      /x\.packageCommit === expected\.packageSha && x\.packageBuildId === expected\.packageBuildId/.test(g));
    check('the guard reads provenance from the BUILT artefact',
      /standalone', 'watson-build\.json'/.test(g));
    check('the guard refuses a package whose provenance sha differs from HEAD',
      /package provenance sha \$\{prov\.sha\} != HEAD/.test(g));
    check('the guard refuses a package built from a dirty tree',
      /prov\.sourceDirtyAtBuild\) fail/.test(g));
    check('the guard still restarts to remount before polling',
      g.indexOf('restart to remount the package') < g.indexOf('poll every active worker'));
    check('the guard polls EVERY active worker, not just one',
      /activeWorkerCount\(\)/.test(g) && /seen\.size >= wanted/.test(g));
    check('the guard forgets stale workers rather than accepting them',
      /if \(!matches\(v\)\) seen\.delete\(k\)/.test(g));
    check('worker disagreement is its own failure step',
      /verify all workers agree on the package fingerprint/.test(g));
    check('the verdict reports app-setting SHA and package SHA as SEPARATE claims',
      /appSettingSha:/.test(g) && /packageSha:/.test(g));
    check('shaMatch is computed from the package, not the app setting',
      /shaMatch: Boolean\(sha\?\.head && served\?\.body\?\.packageCommit/.test(g));
    check('the posture step checks the running package against HEAD',
      /running package \$\{h\.packageCommit\} != HEAD/.test(g));
    check('the old hollow check is gone',
      !/if \(h\.commit === sha\.head\) return h;/.test(g));
    // The ORDERING defect: writing the app setting before the remount is what
    // created the window in which health advertised a SHA the workers were not
    // serving. It must now happen only after convergence has been proven.
    check('the app-setting SHA is written AFTER convergence, not before the deploy',
      g.indexOf('poll every active worker') < g.indexOf('WATSON_DEPLOYED_SHA=${sha.head}'));
    check('the deploy step no longer writes the app-setting SHA',
      !/deploy the package[\s\S]{0,400}WATSON_DEPLOYED_SHA/.test(g));
    check('a missing RuntimeSuccessful string is confirmed against the deployments API',
      /neither RuntimeSuccessful nor a successful deployment record/.test(g) &&
      /Number\(d\.status\) === 4/.test(g));
    check('the posture check re-reads health after the setting write restarts the app',
      /posture=\$\{Date\.now\(\)\}/.test(g));

    // Provenance generation must be part of the build, or the artefact ships
    // without the very thing the guard depends on.
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    check('build provenance is generated as part of npm run build',
      /write-build-provenance\.mjs/.test(pkg.scripts.build), pkg.scripts.build);
    check('provenance is generated AFTER next build, so BUILD_ID exists',
      pkg.scripts.build.indexOf('next build') < pkg.scripts.build.indexOf('write-build-provenance'));
    const w = readFileSync('scripts/write-build-provenance.mjs', 'utf8');
    check('provenance is written into the standalone root that gets packaged',
      /standalone.*watson-build\.json|watson-build\.json/.test(w) && /'\.next', 'standalone'/.test(w));
    check('provenance captures the git SHA itself rather than trusting a caller',
      /git rev-parse HEAD/.test(w) && !/process\.argv/.test(w));
    check('provenance records whether the tree was dirty at build time',
      /sourceDirtyAtBuild/.test(w));

    const bp = readFileSync('src/lib/it-agent/build-provenance.ts', 'utf8');
    check('the runtime reader falls back to BUILD_ID so a stale mount stays detectable',
      /BUILD_ID/.test(bp));
    check('missing provenance yields nulls rather than a guess',
      /const MISSING: PackageProvenance = \{ packageSha: null/.test(bp));
    check('provenance is cached so health does no file I/O per request',
      /if \(cached\) return cached;/.test(bp));

    const hr = readFileSync('src/app/api/health/route.ts', 'utf8');
    check('health exposes the package-embedded commit',  /packageCommit: prov\.packageSha/.test(hr));
    check('health exposes the package build id',         /packageBuildId: prov\.packageBuildId/.test(hr));
    check('health still exposes the app-setting commit, labelled as such',
      /commit: process\.env\.WATSON_DEPLOYED_SHA/.test(hr) && /APP SETTING/.test(hr));
  }

  console.log('\n[138] Store cutover — a switch is refused while multiple workers run (021G-3)');
  {
    check('a switch is permitted with exactly one worker', storeSwitchPermitted(1) === true);
    check('a switch is REFUSED with two workers', storeSwitchPermitted(2) === false,
      'a rolling restart puts the two workers on different stores');
    check('a switch is refused with three workers', storeSwitchPermitted(3) === false);
    check('a switch with two workers is permitted ONLY with an explicit override',
      storeSwitchPermitted(2, true) === true);
    check('zero workers is not a safe switch either', storeSwitchPermitted(0) === false);

    const mixed: WorkerHealth[] = [
      { workerId: 'w1', rbacStore: 'json_legacy', packageCommit: 'aaaa1111', packageBuildId: 'BUILD-NEW' },
      { workerId: 'w2', rbacStore: 'postgres', packageCommit: 'aaaa1111', packageBuildId: 'BUILD-NEW' }
    ];
    check('the observed mixed-store window is detected as disagreement',
      storesAgree(mixed) === false, 'exactly what was seen during the 021G-3 rollback drill');
    check('workers on one store agree', storesAgree([fresh('w1'), fresh('w2')]) === true);
    check('a mixed store is NOT masked by matching package fingerprints',
      workersAgree(mixed) === true && storesAgree(mixed) === false,
      'the package check alone would have passed this');

    const c = readFileSync('scripts/cutover-store.mjs', 'utf8');
    check('the cutover script refuses a multi-worker switch by default',
      /refuse a store switch while multiple workers are active/.test(c));
    check('the override is explicit and loudly named',
      /--i-accept-a-mixed-store-window/.test(c) && /explicitly overridden/.test(c));
    check('the procedure scales to one worker BEFORE changing the setting',
      c.indexOf('scale to one worker and wait for convergence') < c.indexOf('change WATSON_RBAC_STORE and remount'));
    check('the setting change is followed by a restart to remount',
      /az webapp restart/.test(c) && c.indexOf('appsettings set') < c.indexOf('az webapp restart'));
    check('the sole worker is verified on store AND package SHA before scaling up',
      c.indexOf('verify the sole worker reports the intended store and package SHA') < c.indexOf('scale back to'));
    check('scaling up happens only after that verification',
      c.indexOf('verify the sole worker') < c.indexOf('scale back to ${FINAL_WORKERS}'));
    check('every worker must agree before mutations are permitted',
      /verify every worker agrees on store and package before permitting mutations/.test(c) &&
      /mutationsPermitted: true/.test(c));
    check('the agreement check requires unanimity, not a single sample',
      /stores\.length !== 1/.test(c) && /ids\.length < FINAL_WORKERS/.test(c));
    check('postgres must additionally report multiInstanceSafe',
      /MultiInstanceSafe !== true/.test(c));
    check('convergence means one worker answering repeatedly, not one ARM record',
      /ids\.size === 1 && instanceCount\(\) === 1/.test(c));
    check('the cutover script never prints a secret',
      !/password|--admin-password|accessToken/i.test(c));
    // A cutover verifies the running package matches the COMMITTED SOURCE. It must
    // not demand BUILD_ID equality with a local build: Next mints a new BUILD_ID
    // every build, so an unrelated rebuild would fail a healthy cutover. Inside a
    // DEPLOY the artefact checked IS the one just built, so there BUILD_ID is
    // correct — the two scripts legitimately differ here.
    check('the cutover does NOT verify against a local build artefact',
      !/packageSha: prov\?\.sha/.test(c) && !/standalone', 'watson-build\.json'/.test(c),
      'a local rebuild mints a new BUILD_ID and would fail a healthy cutover');
    check('BUILD_ID can still be pinned explicitly when the artefact is known',
      /--expect-build-id/.test(c));
    // The safety property for a cutover is that the running code does not change
    // while the store setting does. Verifying against the CURRENTLY DEPLOYED
    // package expresses that; demanding equality with HEAD would merely refuse
    // the legitimate case of cutting over a previously deployed build.
    check('the cutover captures the deployed package SHA as its baseline',
      /baseline = health\('baseline'\)\.packageCommit/.test(c));
    check('the cutover refuses to proceed if it cannot read the deployed package',
      /refusing to cut over blind/.test(c));
    check('an exact package can be pinned with --expect-sha', /--expect-sha/.test(c));
    check('the cutover records whether the deployed package matches HEAD',
      /matchesHead/.test(c));
    check('the deploy guard, by contrast, DOES require BUILD_ID equality',
      /packageBuildId === expected\.packageBuildId/.test(readFileSync('scripts/deploy-staging.mjs', 'utf8')));
  }

  console.log('\n[139] Cold-start store probe — bounded, but no false unhealthy (021G-3)');
  {
    const hr = readFileSync('src/app/api/health/route.ts', 'utf8');
    check('the cold probe budget is larger than the 8s that produced false failures',
      /COLD_PROBE_BUDGET_MS = 1[5-9]_000|COLD_PROBE_BUDGET_MS = [2-9]\d_000/.test(hr));
    check('a timed-out first attempt is retried once against a warm pool',
      /result\.cause === 'probe_timeout'\) \{\s*\n\s*result = await attempt\(WARM_PROBE_BUDGET_MS\)/.test(hr));
    check('the retry is distinguishable from a cold-start timeout',
      /probe_timeout_after_retry/.test(hr));
    check('the probe remains BOUNDED — no unbounded wait was introduced',
      /Promise\.race/.test(hr) && /setTimeout/.test(hr));
    check('only a timeout is retried; a real refusal is reported immediately',
      /result\.cause === 'probe_timeout'/.test(hr) && !/result\.ok === false\) \{\s*result = await attempt/.test(hr));
    // Comment text is line-wrapped, so the prose is normalised before matching:
    // an assertion that breaks when a comment rewraps tests formatting, not intent.
    const prose = hr.replace(/^\s*\/\/ ?/gm, ' ').replace(/\s+/g, ' ');
    check('the reason for the larger budget is documented, not silently tuned',
      /COLD START/.test(prose) && /false unhealthy result is not harmless/.test(prose), prose.slice(0, 0));
  }

  console.log('\n[140] RBAC responses name the serving worker (021G-3)');
  {
    const h = readFileSync('src/lib/it-agent/rbac/http.ts', 'utf8');
    check('every RBAC response carries the serving worker id',
      /'x-watson-worker'/.test(h));
    check('it is stamped on the shared response options, covering all routes',
      /export const NO_STORE = \{[\s\S]{0,220}x-watson-worker/.test(h));
    check('the worker id is truncated and carries no tenant data',
      /WEBSITE_INSTANCE_ID \?\? 'local'\)\.slice\(0, 12\)/.test(h));
    check('no-store caching is preserved alongside it',
      /'Cache-Control': 'no-store'/.test(h));
  }

  return { pass, fail, failures };
}
