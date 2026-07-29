/* ============================================================
 * Watson — 021G-2 : async RBAC contract, missing-await hazards and fail-closed.
 * Deterministic; NO network, NO database, NO real identity.
 *
 * The defect class this suite exists to catch: a Promise is TRUTHY. If any call
 * site forgets `await` on an authorization check, `if (actorHasCapability(...))`
 * is unconditionally true and everyone becomes an administrator. Types catch
 * most of it; these tests catch the rest and pin the source shape.
 * ============================================================ */
import { readFileSync } from 'node:fs';
import { MemoryRbacStore } from '../src/lib/it-agent/rbac/memory-adapter';
import { __setRbacStoreForTests, configuredStoreKind, validateStoreConfiguration,
  rbacStoreProvenance, StoreConfigurationError } from '../src/lib/it-agent/rbac/store-provider';
import {
  currentRoles, actorHasCapability, readRegistry, readEmployeeRoles, readAuditHistory,
  previewAssignment, confirmAssignment, previewRemoval, confirmRemoval, searchEmployees,
  ensureBootstrap, runBootstrap, __resetBootstrapGuardForTests, __resetPreviewsForTests,
  type TrustedIdentity
} from '../src/lib/it-agent/rbac/service';
import { authorizeRbacEntry } from '../src/lib/it-agent/rbac/entry';

const OID = (n: number) => `00000000-0000-4000-7000-${String(n).padStart(12, '0')}`;
const A = OID(1), B = OID(2);
const id = (oid: string): TrustedIdentity => ({ oid, upn: 'x@staged.invalid', displayName: 'X' });
const bare = { get: () => null };

export async function runRbacAsyncTests(): Promise<{ pass: number; fail: number; failures: string[] }> {
  let pass = 0, fail = 0; const failures: string[] = [];
  const check = (n: string, c: boolean, d = '') => {
    if (c) { pass++; console.log('  ✅ ' + n); }
    else { fail++; failures.push(n + (d ? ` — ${d}` : '')); console.log('  ❌ ' + n + (d ? ` — ${d}` : '')); }
  };

  // Swap in the reference adapter so these tests never touch the JSON store.
  const store = new MemoryRbacStore();
  __setRbacStoreForTests(store);
  const fresh = () => { store.reset(); __resetBootstrapGuardForTests(); __resetPreviewsForTests(); };

  console.log('\n[127] RBAC async — every stateful operation returns a Promise (021G-2)');
  {
    fresh();
    const ops: Array<[string, unknown]> = [
      ['currentRoles', currentRoles(A)],
      ['actorHasCapability', actorHasCapability(id(A), 'rbac.registry.read')],
      ['readRegistry', readRegistry(id(A))],
      ['readEmployeeRoles', readEmployeeRoles(id(A), B)],
      ['readAuditHistory', readAuditHistory(id(A))],
      ['previewAssignment', previewAssignment(id(A), B, 'watson_technician')],
      ['confirmAssignment', confirmAssignment(id(A), { nonce: 'x', targetOid: B, role: 'watson_technician' })],
      ['previewRemoval', previewRemoval(id(A), B, 'watson_technician')],
      ['confirmRemoval', confirmRemoval(id(A), { nonce: 'x', targetOid: B, role: 'watson_technician' })],
      ['searchEmployees', searchEmployees(id(A), 'sam', [])],
      ['ensureBootstrap', ensureBootstrap({} as NodeJS.ProcessEnv)],
      ['runBootstrap', runBootstrap({} as NodeJS.ProcessEnv)],
      ['authorizeRbacEntry', authorizeRbacEntry(bare, 'rbac.registry.read', {} as NodeJS.ProcessEnv)]
    ];
    for (const [name, v] of ops) {
      check(`${name} returns a Promise`, v instanceof Promise, typeof v);
    }
    // Settle them all so nothing becomes an unhandled rejection.
    const settled = await Promise.allSettled(ops.map(([, v]) => v as Promise<unknown>));
    check('no stateful operation rejects unexpectedly',
      settled.every((s) => s.status === 'fulfilled'),
      JSON.stringify(settled.filter((s) => s.status === 'rejected').slice(0, 2)));
  }

  console.log('\n[128] RBAC async — the Promise-truthiness authorization hazard (021G-2)');
  {
    fresh();
    // The whole point: an UNAWAITED authorization check is truthy even when the
    // answer is false. This documents the hazard and proves the awaited value
    // is what the code actually uses.
    const unawaited = actorHasCapability(id(B), 'rbac.registry.read');
    check('an unawaited capability check is truthy even for a non-admin', Boolean(unawaited) === true);
    check('the AWAITED value is correctly false for a non-admin', (await unawaited) === false);

    // No call site may treat the Promise as the decision.
    const entry = readFileSync('src/lib/it-agent/rbac/entry.ts', 'utf8');
    check('entry awaits the capability check', /await actorHasCapability\(/.test(entry));
    check('entry never uses the bare call as a condition',
      !/(if|\?|&&|\|\|)\s*actorHasCapability\(/.test(entry) && !/authorized:\s*actorHasCapability\(/.test(entry));
    const svc = readFileSync('src/lib/it-agent/rbac/service.ts', 'utf8');
    check('service awaits its own capability check', /await actorHasCapability\(/.test(svc));
    check('every requireCapability call site is awaited',
      (svc.match(/requireCapability\(/g) || []).length ===
      (svc.match(/await requireCapability\(/g) || []).length + 1, // +1 = the declaration
      String((svc.match(/requireCapability\(/g) || []).length));
    check('every currentRoles call site inside the service is awaited',
      !/[^t.]\bcurrentRoles\(/.test(svc.replace(/await currentRoles\(/g, 'await X(').replace(/export async function currentRoles\(/g, 'decl(')),
      'unawaited currentRoles call remains');

    // Routes and page must await too.
    for (const p of ['registry', 'search', 'employee', 'audit', 'assign/preview', 'assign/confirm', 'remove/preview', 'remove/confirm']) {
      const r = readFileSync(`src/app/api/it-agent/rbac/${p}/route.ts`, 'utf8');
      check(`route ${p} awaits the service call`, /=\s*await \w+\(/.test(r));
      check(`route ${p} returns no unresolved Promise`, !/NextResponse\.json\(\s*\w+\(/.test(r));
    }
    const page = readFileSync('src/app/admin/access-and-roles/page.tsx', 'utf8');
    check('the page awaits the authority decision', /await authorizeRbacEntry\(/.test(page));
  }

  console.log('\n[129] RBAC async — fail closed, never permissive (021G-2)');
  {
    fresh();
    await store.tryBootstrap(A, 'boot');
    check('the bootstrapped admin is authorized', (await readRegistry(id(A))).ok === true);

    // Store unavailable during authorization must NOT read as authorized, and
    // must be distinguishable from a plain refusal.
    store.inject = { unavailable: true };
    const r = await readRegistry(id(A));
    check('store unavailable during authorization fails closed', r.ok === false);
    check('store unavailability is not reported as "not_authorized"',
      r.ok === false && r.reason === 'store_unavailable', r.ok ? 'ok' : r.reason);

    const p = await previewAssignment(id(A), B, 'watson_technician');
    check('store unavailable during preview fails closed', p.ok === false);
    const c = await confirmAssignment(id(A), { nonce: 'x', targetOid: B, role: 'watson_technician' });
    check('store unavailable during confirmation fails closed', c.ok === false);
    const au = await readAuditHistory(id(A));
    check('store unavailable during audit listing fails closed', au.ok === false);
    const ent = await authorizeRbacEntry(bare, 'rbac.registry.read', { WATSON_LOCAL_TEST_OID: A, NODE_ENV: 'development' } as unknown as NodeJS.ProcessEnv);
    check('page entry fails closed when the store is unavailable', ent.authorized === false);
    store.inject = {};

    // A mutation must never report success when its audit append fails.
    fresh();
    await store.tryBootstrap(A, 'boot');
    const pv = await previewAssignment(id(A), B, 'watson_technician');
    store.inject = { failAuditWrite: true };
    const done = pv.ok
      ? await confirmAssignment(id(A), { nonce: pv.data.nonce, targetOid: B, role: 'watson_technician' })
      : { ok: false as const, reason: 'stale_preview' as const };
    check('a mutation whose audit fails is NOT reported successful', done.ok === false, JSON.stringify(done));
    store.inject = {};
    check('no role was granted by the failed mutation', (await currentRoles(B)).length === 0);
  }

  console.log('\n[130] RBAC async — initialization and store selection (021G-2)');
  {
    fresh();
    const env = { WATSON_RBAC_BOOTSTRAP_OID: A } as unknown as NodeJS.ProcessEnv;
    // Concurrent initialization must not create two bootstrap records.
    await Promise.all(Array.from({ length: 8 }, () => ensureBootstrap(env)));
    check('concurrent initialization creates exactly one administrator',
      (await store.countActiveRoleAdmins()) === 1, String(await store.countActiveRoleAdmins()));
    check('concurrent initialization writes exactly one bootstrap success',
      (await store.listAudit({ limit: 500 })).filter((e) => e.operation === 'bootstrap' && e.outcome === 'success').length === 1);
    __resetBootstrapGuardForTests();
    await ensureBootstrap(env);
    check('repeat initialization stays idempotent', (await store.countActiveRoleAdmins()) === 1);

    // Store selection: explicit, fail-closed.
    check('absent configuration selects json', configuredStoreKind({} as NodeJS.ProcessEnv) === 'json');
    check('memory is selectable', configuredStoreKind({ WATSON_RBAC_STORE: 'memory' } as unknown as NodeJS.ProcessEnv) === 'memory');
    let threw = false;
    try { configuredStoreKind({ WATSON_RBAC_STORE: 'mysql' } as unknown as NodeJS.ProcessEnv); }
    catch (e) { threw = e instanceof StoreConfigurationError; }
    check('an unknown store type fails configuration', threw);
    check('unknown store type is reported by the config gate',
      validateStoreConfiguration({ WATSON_RBAC_STORE: 'mysql' } as unknown as NodeJS.ProcessEnv).reasonCodes.includes('rbac_store_unknown'));
    const pg = validateStoreConfiguration({ WATSON_RBAC_STORE: 'postgres' } as unknown as NodeJS.ProcessEnv);
    check('selecting postgres without configuration fails closed', pg.ok === false);
    check('postgres failure names the missing adapter, not a fallback',
      pg.reasonCodes.includes('rbac_store_pg_adapter_unavailable'));
    check('json configuration validates', validateStoreConfiguration({} as NodeJS.ProcessEnv).ok === true);

    // Provenance: honest about multi-instance safety, silent about connections.
    const prov = rbacStoreProvenance({} as NodeJS.ProcessEnv);
    check('provenance identifies the json store', prov.store === 'json_legacy');
    check('the json store is NOT claimed multi-instance safe', prov.multiInstanceSafe === false);
    check('postgres provenance would be multi-instance safe',
      rbacStoreProvenance({ WATSON_RBAC_STORE: 'postgres' } as unknown as NodeJS.ProcessEnv).multiInstanceSafe === true);
    check('provenance exposes no connection detail',
      !/host|password|user|sslmode|connection/i.test(JSON.stringify(prov)));

    const provider = readFileSync('src/lib/it-agent/rbac/store-provider.ts', 'utf8');
    check('there is NO silent fallback from postgres to json',
      /never degrade to JSON|no fallback path/i.test(provider) && !/catch[\s\S]{0,80}JsonRbacStore/.test(provider));
    const json = readFileSync('src/lib/it-agent/rbac/json-adapter.ts', 'utf8');
    check('the json adapter does not claim multi-instance safety',
      /NOT MULTI-INSTANCE SAFE/.test(json));
    check('the json adapter serializes its mutations', /queue\(/.test(json) && /SERIALIZED/.test(json));
    check('the service holds no process-local role cache',
      !/roleCache|cachedRoles|authorityCache/i.test(readFileSync('src/lib/it-agent/rbac/service.ts', 'utf8')));
  }

  console.log('\n[131] RBAC async — behaviour preserved through the conversion (021G-2)');
  {
    fresh();
    await store.tryBootstrap(A, 'boot');
    // Grant -> visible on the NEXT call, read from durable state.
    const pv = await previewAssignment(id(A), B, 'watson_technician');
    check('preview issued', pv.ok === true);
    check('no optimistic mutation from a preview', (await currentRoles(B)).length === 0);
    const cf = pv.ok ? await confirmAssignment(id(A), { nonce: pv.data.nonce, targetOid: B, role: 'watson_technician' }) : null;
    check('confirm applies the grant', cf?.ok === true && cf.data.applied === true);
    check('authority appears on the next read', (await currentRoles(B)).join() === 'watson_technician');

    // Replay of the consumed nonce.
    const replay = pv.ok ? await confirmAssignment(id(A), { nonce: pv.data.nonce, targetOid: B, role: 'watson_technician' }) : null;
    check('a consumed nonce cannot be replayed', replay?.ok === false);
    check('replay reason is a safe binding category',
      replay?.ok === false && ['replayed_preview', 'stale_preview'].includes(replay.reason), replay?.ok ? '' : replay?.reason);

    // Revocation -> gone on the next read.
    const rp = await previewRemoval(id(A), B, 'watson_technician');
    const rc = rp.ok ? await confirmRemoval(id(A), { nonce: rp.data.nonce, targetOid: B, role: 'watson_technician', elevatedAcknowledged: true }) : null;
    check('revocation applies', rc?.ok === true && rc.data.applied === true);
    check('authority disappears on the next read', (await currentRoles(B)).length === 0);

    // Final-administrator protection still holds through the async path.
    const lp = await previewRemoval(id(A), A, 'watson_role_admin');
    const lc = lp.ok ? await confirmRemoval(id(A), { nonce: lp.data.nonce, targetOid: A, role: 'watson_role_admin', elevatedAcknowledged: true }) : null;
    check('the final administrator still cannot be removed',
      lc?.ok === false && lc.reason === 'last_admin_protected', lc?.ok ? 'applied' : lc?.reason);
    check('the administrator survived', (await store.countActiveRoleAdmins()) === 1);

    // Cross-actor nonce isolation survives the conversion.
    await store.grantRole({
      targetOid: B, targetDisplayName: null, targetUpn: null, role: 'watson_role_admin',
      source: 'administrator', actorOid: A, actorUpn: null, correlationId: 'c',
      elevatedAcknowledged: true, previousRoles: [], resultingRoles: ['watson_role_admin']
    });
    const mine = await previewAssignment(id(A), B, 'watson_technician');
    const stolen = mine.ok ? await confirmAssignment(id(B), { nonce: mine.data.nonce, targetOid: B, role: 'watson_technician' }) : null;
    check('another administrator cannot spend the preview', stolen?.ok === false);
    check('cross-actor refusal is actor_mismatch',
      stolen?.ok === false && stolen.reason === 'actor_mismatch', stolen?.ok ? '' : stolen?.reason);
  }

  __setRbacStoreForTests(null);
  return { pass, fail, failures };
}
