/* ============================================================
 * Watson — 021C-1A : local RBAC bootstrap through the REAL request path.
 *
 * 021C-1 wired ensureBootstrap() into the request path, but browser validation
 * still landed on "You do not have permission to administer Watson roles."
 * The cause was not in the RBAC code: the self-test suite had been writing its
 * synthetic fixtures — INCLUDING ACTIVE watson_role_admin ASSIGNMENTS — into the
 * real local dev store, because src/lib/store/db.ts snapshotted IT_AGENT_PERSIST
 * into a module-level const that was evaluated (via hoisted imports) before the
 * harness could set it. Bootstrap then correctly refused with
 * `persistent_admin_exists` forever after.
 *
 * These tests pin BOTH halves: the store must stay hermetic, and the configured
 * local identity must become administrator through the page and API paths.
 * Deterministic; no network, no Graph, no tenant write.
 * ============================================================ */
import { execSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorizeRbacEntry } from '../src/lib/it-agent/rbac/entry';
import { trustedIdentityFromHeaders } from '../src/lib/it-agent/rbac/http';
import { storagePosture } from '../src/lib/store/db';
import { capabilitiesFor } from '../src/lib/it-agent/rbac/roles';
import {
  __resetRbacForTests, activeRoles, allAssignments, commitAtomically, countActiveRoleAdmins,
  deactivateAssignment, listAudit, upsertActiveAssignment
} from '../src/lib/it-agent/rbac/store';
import {
  __resetBootstrapGuardForTests, __resetPreviewsForTests, currentRoles,
  lastBootstrapOutcome, readRegistry, type TrustedIdentity
} from '../src/lib/it-agent/rbac/service';
import { GET as registryGET } from '../src/app/api/it-agent/rbac/registry/route';
import { GET as employeeGET } from '../src/app/api/it-agent/rbac/employee/route';

// The exact synthetic identity used for local browser validation.
const BOOT = '00000000-0000-0000-0000-000000000777';
const OTHER = '00000000-0000-4000-8000-000000000901';
const idOf = (oid: string): TrustedIdentity => ({ oid, upn: 'x@staged.invalid', displayName: 'X' });

// A request that carries nothing: no principal, no cookie, no role header. This
// is what a local browser actually sends.
const bareHeaders = { get: () => null };

// A request that carries everything a browser could try.
function hostileHeaders(forgedOid: string) {
  const principal = Buffer.from(JSON.stringify({
    claims: [{ typ: 'http://schemas.microsoft.com/identity/claims/objectidentifier', val: forgedOid }]
  })).toString('base64');
  const bag: Record<string, string> = {
    'x-ms-client-principal': principal,
    'x-watson-role': 'watson_role_admin',
    'x-watson-oid': forgedOid,
    cookie: `watson_role=watson_role_admin; watson_oid=${forgedOid}`,
    authorization: 'Bearer not-a-real-token'
  };
  return { get: (n: string) => bag[n.toLowerCase()] ?? null };
}

const devEnv = (over: Record<string, string | undefined> = {}) => {
  const base: Record<string, string | undefined> = {
    NODE_ENV: 'development',
    WATSON_LOCAL_TEST_OID: BOOT,
    WATSON_RBAC_BOOTSTRAP_OID: BOOT
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete base[k]; else base[k] = v;
  }
  return base as unknown as NodeJS.ProcessEnv;
};

function seedAdmin(oid: string) {
  commitAtomically(
    () => upsertActiveAssignment({
      targetOid: oid, targetDisplayName: null, targetUpn: null,
      role: 'watson_role_admin', source: 'migration', actorOid: 'system:test'
    }),
    {
      correlationId: 'seed', actorOid: 'system:test', actorUpn: null, targetOid: oid,
      operation: 'seed', outcome: 'success', reason: 'seed', previousRoles: [],
      resultingRoles: ['watson_role_admin'], source: 'migration', elevatedAcknowledged: null
    }
  );
}

// Clean slate: no assignments, no audit, bootstrap never attempted.
function freshProcess() {
  __resetRbacForTests();
  __resetPreviewsForTests();
  __resetBootstrapGuardForTests();
}

// Run something with the seam configured in the REAL process environment, so a
// route handler that reads process.env directly is exercised honestly.
async function withProcessEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

const ROLE_ADMIN_CAPS = ['rbac.assign', 'rbac.audit.read', 'rbac.employee.read', 'rbac.registry.read', 'rbac.remove'];

export async function runRbacLocalBootstrapTests(): Promise<{ pass: number; fail: number; failures: string[] }> {
  let pass = 0, fail = 0; const failures: string[] = [];
  const check = (n: string, c: boolean, d = '') => {
    if (c) { pass++; console.log('  ✅ ' + n); }
    else { fail++; failures.push(n + (d ? ` — ${d}` : '')); console.log('  ❌ ' + n + (d ? ` — ${d}` : '')); }
  };

  console.log('\n[104] RBAC local bootstrap — store hermeticity (the 021C-1A root cause)');
  {
    // 1. The suite itself must never write to the local dev store.
    check('self-test run has persistence disabled', storagePosture().persistEnabled === false,
      JSON.stringify(storagePosture().persistEnabled));

    const dbSrc = readFileSync('src/lib/store/db.ts', 'utf8');
    check('persistence flag is NOT snapshotted into a module-level const',
      !/^const\s+PERSIST\s*=/m.test(dbSrc) && /function persistEnabled\(\)/.test(dbSrc));
    check('data file path is NOT snapshotted into a module-level const',
      !/^const\s+DATA_FILE\s*=/m.test(dbSrc) && /function dataFile\(\)/.test(dbSrc));
    check('the import-order hazard is documented where it bit',
      /hoisted and evaluated BEFORE/.test(dbSrc));

    // The decisive proof: a fresh process that sets IT_AGENT_PERSIST='off' in its
    // module body (after hoisted imports have already evaluated db.ts) must still
    // write nothing. This is exactly the shape the self-test harness uses.
    let hermetic = false, probeOut = '';
    const dir = mkdtempSync(join(tmpdir(), 'wrbac-'));
    try {
      probeOut = execSync('npx tsx scripts/persist-hermeticity-probe.ts', {
        env: { ...process.env, WATSON_DATA_DIR: dir, IT_AGENT_PERSIST: 'on' },
        encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'ignore']
      });
      hermetic = /HERMETIC_OK/.test(probeOut) && readdirSync(dir).length === 0;
    } catch (e) {
      hermetic = false; probeOut = e instanceof Error ? e.message : String(e);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    check('IT_AGENT_PERSIST=off set after hoisted imports still suppresses every write',
      hermetic, probeOut.trim().slice(0, 120));

    const harness = readFileSync('scripts/it-agent-selftest.ts', 'utf8');
    check('harness clears the operator RBAC seam variables',
      /delete process\.env\.WATSON_LOCAL_TEST_OID/.test(harness)
      && /delete process\.env\.WATSON_RBAC_BOOTSTRAP_OID/.test(harness));
  }

  console.log('\n[105] RBAC local bootstrap — real page authorization path');
  {
    // 2. The page path, with a bare local request, bootstraps the configured id.
    freshProcess();
    check('no roles exist before the first request', currentRoles(BOOT).length === 0);
    const first = authorizeRbacEntry(bareHeaders, 'rbac.registry.read', devEnv());
    check('page path resolves the configured synthetic actor', first.actor?.oid === BOOT);
    check('page path authorizes the configured synthetic actor', first.authorized === true,
      lastBootstrapOutcome());
    check('bootstrap outcome is recorded, not swallowed',
      lastBootstrapOutcome() === 'bootstrap_role_admin_created', lastBootstrapOutcome());
    check('page path reports exactly the role administrator role',
      same(first.roles, ['watson_role_admin']), first.roles.join(','));
    check('page path confers exactly the RBAC capabilities',
      same(capabilitiesFor(first.roles), ROLE_ADMIN_CAPS), capabilitiesFor(first.roles).join(','));
    check('bootstrap assignment is recorded with source=bootstrap',
      allAssignments().filter((a) => a.targetOid === BOOT && a.active && a.source === 'bootstrap').length === 1);

    // 3. No stale empty-role result survives a successful bootstrap: the very
    //    same call that ran bootstrap must already see the role.
    check('no stale empty-role state survives bootstrap', currentRoles(BOOT).length === 1);

    // 4. The capability is present on the NEXT request too (guard already set,
    //    so this request runs with bootstrap a no-op).
    const second = authorizeRbacEntry(bareHeaders, 'rbac.registry.read', devEnv());
    check('role-admin capabilities are present on the next request', second.authorized === true);
    check('second request creates no additional assignment',
      allAssignments().filter((a) => a.targetOid === BOOT && a.active).length === 1);

    const pageSrc = readFileSync('src/app/admin/access-and-roles/page.tsx', 'utf8');
    check('the page delegates to the shared RBAC entry point',
      /authorizeRbacEntry/.test(pageSrc) && !/ensureBootstrap/.test(pageSrc));
    const entrySrc = readFileSync('src/lib/it-agent/rbac/entry.ts', 'utf8');
    check('the entry point bootstraps before resolving identity',
      entrySrc.indexOf('ensureBootstrap(env)') < entrySrc.indexOf('trustedIdentityFromHeaders(headers'));
  }

  console.log('\n[106] RBAC local bootstrap — real API path and shared state');
  {
    // 5. The real route handlers, reading the real process env, must see the
    //    same assignment the page path created.
    freshProcess();
    authorizeRbacEntry(bareHeaders, 'rbac.registry.read', devEnv());

    const seam = { WATSON_LOCAL_TEST_OID: BOOT, WATSON_RBAC_BOOTSTRAP_OID: BOOT };
    const regRes = await withProcessEnv(seam, () =>
      registryGET(new Request('http://localhost:3021/api/it-agent/rbac/registry')));
    check('real registry route returns 200 for the bootstrapped local admin', regRes.status === 200,
      String(regRes.status));
    const regBody = await regRes.json();
    check('registry route body carries the six-role registry',
      Object.keys(regBody.roles ?? {}).length === 6);

    const empRes = await withProcessEnv(seam, () =>
      employeeGET(new Request(`http://localhost:3021/api/it-agent/rbac/employee?oid=${BOOT}`)));
    const empBody = await empRes.json();
    check('real employee route reports watson_role_admin for the local admin',
      empRes.status === 200 && Array.isArray(empBody.roles) && empBody.roles.includes('watson_role_admin'),
      `${empRes.status} ${JSON.stringify(empBody).slice(0, 120)}`);
    check('real employee route reports exactly the RBAC capabilities',
      same(empBody.capabilities ?? [], ROLE_ADMIN_CAPS), JSON.stringify(empBody.capabilities));

    // 6. Bootstrap and requireCapability read ONE store instance. Proven by
    //    mutating through the store module and observing the change through the
    //    service and route paths, with no reset in between.
    check('service authorization agrees with the store immediately', readRegistry(idOf(BOOT)).ok === true);
    deactivateAssignment({ targetOid: BOOT, role: 'watson_role_admin', actorOid: 'system:test' });
    check('a store-level removal is seen by requireCapability at once',
      readRegistry(idOf(BOOT)).ok === false);
    // 7. Page and routes share that same state — no per-layer copy.
    const afterRemoval = authorizeRbacEntry(bareHeaders, 'rbac.registry.read', devEnv());
    check('page path sees the same removal the API path saw', afterRemoval.authorized === false);
    const regRes2 = await withProcessEnv(seam, () =>
      registryGET(new Request('http://localhost:3021/api/it-agent/rbac/registry')));
    check('real route also refuses after the same removal', regRes2.status === 403, String(regRes2.status));

    // 8. Runtime state is anchored process-wide, so module duplication under
    //    Next.js/Turbopack cannot produce two RBAC worlds.
    const g = globalThis as unknown as { __watsonRbacRuntime?: unknown; __watsonDb?: unknown };
    check('RBAC runtime state is anchored on globalThis', g.__watsonRbacRuntime !== undefined);
    check('durable store is anchored on globalThis', g.__watsonDb !== undefined);
    const svcSrc = readFileSync('src/lib/it-agent/rbac/service.ts', 'utf8');
    check('bootstrap guard is not module-local', !/^let bootstrapAttempted/m.test(svcSrc));
    check('preview map is not module-local', !/^const PREVIEWS = new Map/m.test(svcSrc));
  }

  console.log('\n[107] RBAC local bootstrap — duplicate prevention and audit');
  {
    // 9. Hot reload (module re-evaluation) resets only the in-process guard.
    //    Repeated bootstrap attempts must never mint a second administrator.
    freshProcess();
    for (let i = 0; i < 5; i++) {
      __resetBootstrapGuardForTests();               // simulate a hot reload
      authorizeRbacEntry(bareHeaders, 'rbac.registry.read', devEnv());
      readRegistry(idOf(BOOT));                       // and an API request
    }
    check('hot reload and repeated requests never create a duplicate administrator',
      countActiveRoleAdmins() === 1, String(countActiveRoleAdmins()));
    check('exactly one active assignment exists for the local admin',
      allAssignments().filter((a) => a.targetOid === BOOT && a.active).length === 1);

    // 10. The bootstrap SUCCESS audit is written exactly once, however many
    //     requests and reloads follow.
    const successes = listAudit({ targetOid: BOOT, limit: 500 })
      .filter((e) => e.operation === 'bootstrap' && e.outcome === 'success');
    check('bootstrap audit is created exactly once', successes.length === 1, String(successes.length));
    check('bootstrap audit names the system actor, never a request actor',
      successes[0]?.actorOid === 'system:bootstrap' && successes[0]?.source === 'bootstrap');
    check('later bootstrap attempts are audited as refusals, not successes',
      listAudit({ targetOid: BOOT, limit: 500 })
        .filter((e) => e.operation === 'bootstrap' && e.outcome === 'refused')
        .every((e) => e.reason === 'persistent_admin_exists'));

    // 11. An existing active administrator prevents any further bootstrap —
    //     including one configured for a different identity.
    freshProcess();
    seedAdmin(OTHER);
    const blocked = authorizeRbacEntry(bareHeaders, 'rbac.registry.read', devEnv());
    check('existing active administrator prevents additional bootstrap',
      countActiveRoleAdmins() === 1 && activeRoles(BOOT).length === 0);
    check('configured identity is NOT granted access when an administrator exists',
      blocked.authorized === false);
    check('the refusal reason is visible to an operator',
      lastBootstrapOutcome() === 'persistent_admin_exists', lastBootstrapOutcome());
  }

  console.log('\n[108] RBAC local bootstrap — configuration must not widen access');
  {
    // 12. Mismatched local and bootstrap identities grant the LOCAL actor nothing.
    freshProcess();
    const mismatched = authorizeRbacEntry(bareHeaders, 'rbac.registry.read',
      devEnv({ WATSON_RBAC_BOOTSTRAP_OID: OTHER }));
    check('mismatched local and bootstrap OIDs do not grant access', mismatched.authorized === false);
    check('bootstrap still applies only to the CONFIGURED identity',
      activeRoles(OTHER).includes('watson_role_admin') && activeRoles(BOOT).length === 0);

    // 13. No bootstrap configuration -> no administrator, no first-user-wins.
    freshProcess();
    const noBoot = authorizeRbacEntry(bareHeaders, 'rbac.registry.read',
      devEnv({ WATSON_RBAC_BOOTSTRAP_OID: undefined }));
    check('missing bootstrap OID does not grant access', noBoot.authorized === false);
    check('missing bootstrap OID creates no administrator at all', countActiveRoleAdmins() === 0);
    check('missing configuration is reported as not-configured',
      lastBootstrapOutcome() === 'bootstrap_not_configured', lastBootstrapOutcome());

    // 14. Malformed configuration is refused, never normalised into something usable.
    const bad = [
      'watson_role_admin',
      'c.hattaway@hrelectriccompany.com',
      '00000000-0000-0000-0000-00000000077',
      '{00000000-0000-0000-0000-000000000777}',
      '00000000000000000000000000000777',
      '00000000-0000-0000-0000-00000000077g',
      '*'
    ];
    let invalidGranted = 0, invalidAdmins = 0;
    for (const v of bad) {
      freshProcess();
      const r = authorizeRbacEntry(bareHeaders, 'rbac.registry.read',
        devEnv({ WATSON_RBAC_BOOTSTRAP_OID: v, WATSON_LOCAL_TEST_OID: v }));
      if (r.authorized) invalidGranted++;
      if (countActiveRoleAdmins() !== 0) invalidAdmins++;
    }
    check('invalid bootstrap OIDs never grant access', invalidGranted === 0, String(invalidGranted));
    check('invalid bootstrap OIDs never create an administrator', invalidAdmins === 0, String(invalidAdmins));

    // Case is normalised consistently on BOTH sides, so an upper-case
    // configuration still matches the resolved identity rather than silently
    // producing an administrator nobody can use.
    freshProcess();
    const upper = authorizeRbacEntry(bareHeaders, 'rbac.registry.read',
      devEnv({ WATSON_RBAC_BOOTSTRAP_OID: BOOT.toUpperCase(), WATSON_LOCAL_TEST_OID: BOOT.toUpperCase() }));
    check('object ids are normalised identically by bootstrap and identity resolution',
      upper.authorized === true && upper.actor?.oid === BOOT);
  }

  console.log('\n[109] RBAC local bootstrap — request input and production inertness');
  {
    // 15. Nothing the browser sends can change who the actor is.
    freshProcess();
    const hostile = authorizeRbacEntry(hostileHeaders(OTHER), 'rbac.registry.read', devEnv());
    check('a forged principal header cannot replace the configured local actor',
      hostile.actor?.oid === BOOT, hostile.actor?.oid ?? 'null');
    check('cookies and role headers cannot elevate the actor',
      same(hostile.roles, ['watson_role_admin']) && activeRoles(OTHER).length === 0);

    freshProcess();
    const hostileNoSeam = authorizeRbacEntry(hostileHeaders(OTHER), 'rbac.registry.read',
      devEnv({ WATSON_LOCAL_TEST_OID: undefined, WATSON_RBAC_BOOTSTRAP_OID: undefined }));
    check('with no seam and no bootstrap, a forged principal is still not an administrator',
      hostileNoSeam.authorized === false && countActiveRoleAdmins() === 0);

    const entrySrc = readFileSync('src/lib/it-agent/rbac/entry.ts', 'utf8');
    const httpSrc = readFileSync('src/lib/it-agent/rbac/http.ts', 'utf8');
    const svcSrc = readFileSync('src/lib/it-agent/rbac/service.ts', 'utf8');
    for (const [name, src] of [['entry', entrySrc], ['http', httpSrc], ['service', svcSrc]] as const) {
      check(`${name} reads no cookie, query string or request body`,
        !/cookies\(\)|searchParams|req\.json\(|request\.json\(/.test(src));
    }
    // Probe the CODE of runBootstrap, with prose stripped, so a comment that
    // merely mentions requests cannot make this pass or fail spuriously.
    const bootstrapCode = svcSrc
      .slice(svcSrc.indexOf('export function runBootstrap'), svcSrc.indexOf('export function ensureBootstrap'))
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    check('bootstrap reads the environment and nothing else',
      /env\.WATSON_RBAC_BOOTSTRAP_OID/.test(bootstrapCode)
      && !/\breq\b|\brequest\b|headers|cookies|searchParams|\bnonce\b/i.test(bootstrapCode));

    // 16. Production ignores the local seam entirely.
    freshProcess();
    const prod = authorizeRbacEntry(bareHeaders, 'rbac.registry.read', devEnv({ NODE_ENV: 'production' }));
    check('production mode resolves no synthetic actor', prod.actor === null);
    check('production mode refuses the unauthenticated request', prod.authorized === false);
    check('production seam is inert even with both variables set',
      trustedIdentityFromHeaders(bareHeaders, devEnv({ NODE_ENV: 'production' })) === null);
    check('production still trusts the platform principal',
      trustedIdentityFromHeaders(hostileHeaders(OTHER), devEnv({ NODE_ENV: 'production' }))?.oid === OTHER);
    check('the seam is documented as production-inert',
      /ignored entirely when NODE_ENV/.test(httpSrc));

    // Leave the shared world clean for anything that runs after us.
    freshProcess();
  }

  return { pass, fail, failures };
}
