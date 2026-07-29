/* ============================================================
 * Watson — 021G-3 : CROSS-WORKER proof against the real Azure database.
 * ------------------------------------------------------------
 * This is the thesis of 021G being tested rather than asserted. Under the JSON
 * store each App Service worker had its own file and its own process-local nonce
 * Map, so a preview issued by worker A was invisible to worker B and two workers
 * could each believe they were removing the second-to-last administrator. Every
 * check below is one that the JSON store WOULD HAVE FAILED.
 *
 * Each "worker" is a separate OS process with its own connection pool, released
 * simultaneously by a wall-clock barrier, so the operations genuinely overlap.
 *
 * Runs entirely inside its own throwaway schema. The migrated staging RBAC data
 * is never read or written, and the schema is dropped at the end.
 * ============================================================ */
import { PostgresRbacStore } from '../src/lib/it-agent/rbac/postgres-adapter';
import { digestNonce, generateNonce } from '../src/lib/it-agent/rbac/persistence';

const OID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN_A = OID(1), ADMIN_B = OID(2), TARGET = OID(3), ACTOR = OID(1);

async function entraToken(): Promise<string> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const { stdout } = await run('az', ['account', 'get-access-token',
    '--resource', 'https://ossrdbms-aad.database.windows.net',
    '--query', 'accessToken', '-o', 'tsv'], { shell: true, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

interface AgentResult { workerId?: string; ok?: boolean; applied?: boolean; reason?: string | null;
  roles?: string[]; admins?: number; error?: string; idempotent?: boolean | null; }

async function spawnWorkers(schema: string, barrier: number, specs: string[][]): Promise<AgentResult[]> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const results = await Promise.all(specs.map(async (args) => {
    try {
      const { stdout } = await run('npx', ['tsx', 'scripts/cross-worker-agent.ts', args[0], schema,
        String(barrier), ...args.slice(1)], { shell: true, maxBuffer: 4 * 1024 * 1024, env: process.env });
      const line = stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
      return line ? (JSON.parse(line) as AgentResult) : { error: 'no_output' };
    } catch (e) {
      return { error: 'spawn_failed:' + (e as Error).message.slice(0, 120) } as AgentResult;
    }
  }));
  return results;
}

async function main(): Promise<void> {
  const host = process.env.WATSON_RBAC_PG_HOST;
  if (!host) { console.error('WATSON_RBAC_PG_HOST not set'); process.exit(2); }
  const schema = 'xw_' + Math.random().toString(36).slice(2, 8);

  let pass = 0, fail = 0; const failures: string[] = [];
  const check = (n: string, c: boolean, d = '') => {
    if (c) { pass++; console.log('  ✅ ' + n); }
    else { fail++; failures.push(n + (d ? ` — ${d}` : '')); console.log('  ❌ ' + n + (d ? ` — ${d}` : '')); }
  };

  const admin = new PostgresRbacStore({
    host, port: 5432, database: process.env.WATSON_RBAC_PG_DATABASE!,
    user: process.env.WATSON_RBAC_PG_USER!, getAccessToken: entraToken, ssl: true, schema,
    connectionTimeoutMillis: 20_000, statementTimeoutMillis: 30_000, maxConnections: 4
  });

  console.log(`\n=== CROSS-WORKER PROOF — separate processes, shared Azure PostgreSQL ===`);
  console.log(`    isolated schema: ${schema} (staging RBAC data is untouched)`);
  try {
    await admin.ensureSchema();

    // ---- Test 1: a preview issued by one worker is CONSUMABLE BY ANOTHER ----
    console.log('\n[XW-1] a preview created by one worker is visible to another');
    const raw = await generateNonce();
    const d = await digestNonce(raw);
    await admin.grantRole({ targetOid: TARGET, targetDisplayName: null, targetUpn: null,
      role: 'watson_employee', source: 'administrator', actorOid: ACTOR, actorUpn: null,
      correlationId: 'seed', elevatedAcknowledged: true, previousRoles: [], resultingRoles: ['watson_employee'] });
    const sv = await admin.roleStateVersion(TARGET);
    await admin.putPreview({ digest: d, operation: 'assign', actorOid: ACTOR, targetOid: TARGET,
      role: 'watson_technician', stateVersion: sv, elevatedRequired: false, payload: '{}',
      expiresAt: new Date(Date.now() + 600_000).toISOString() });

    let barrier = Date.now() + 9_000;
    const consumers = await spawnWorkers(schema, barrier, [
      ['consume-preview', d, ACTOR, TARGET, 'watson_technician'],
      ['consume-preview', d, ACTOR, TARGET, 'watson_technician'],
      ['consume-preview', d, ACTOR, TARGET, 'watson_technician']
    ]);
    console.log('    ' + JSON.stringify(consumers));
    const noErr = consumers.filter((r) => !r.error);
    check('all three worker processes ran', noErr.length === 3,
      JSON.stringify(consumers.filter((r) => r.error)));
    check('a nonce created by one process is CONSUMABLE by a different process',
      noErr.some((r) => r.ok === true),
      'JSON store would fail this: the nonce lived in one process Map');
    check('exactly ONE of three concurrent processes consumed it',
      noErr.filter((r) => r.ok === true).length === 1,
      String(noErr.filter((r) => r.ok === true).length));
    check('the losing processes are refused as replay, not granted',
      noErr.filter((r) => r.ok !== true).every((r) => r.reason === 'replayed_preview'),
      JSON.stringify(noErr.filter((r) => r.ok !== true).map((r) => r.reason)));

    // ---- Test 2: final-administrator protection ACROSS PROCESSES ----
    console.log('\n[XW-2] final-administrator protection holds across processes');
    await admin.tryBootstrap(ADMIN_A, 'xw-boot');
    await admin.grantRole({ targetOid: ADMIN_B, targetDisplayName: null, targetUpn: null,
      role: 'watson_role_admin', source: 'administrator', actorOid: ADMIN_A, actorUpn: null,
      correlationId: 'xw-seed2', elevatedAcknowledged: true, previousRoles: [],
      resultingRoles: ['watson_role_admin'] });
    check('two administrators exist before the race', (await admin.countActiveRoleAdmins()) === 2,
      String(await admin.countActiveRoleAdmins()));

    barrier = Date.now() + 9_000;
    const removers = await spawnWorkers(schema, barrier, [
      ['revoke-admin', ADMIN_A, ADMIN_B],
      ['revoke-admin', ADMIN_B, ADMIN_A]
    ]);
    console.log('    ' + JSON.stringify(removers));
    const survivors = await admin.countActiveRoleAdmins();
    check('two processes removing two different administrators never reach zero',
      survivors >= 1, `survivors=${survivors}`);
    check('exactly one cross-process removal applied',
      removers.filter((r) => r.applied === true).length === 1,
      JSON.stringify(removers.map((r) => ({ ok: r.ok, applied: r.applied, reason: r.reason }))));
    check('the losing process was refused by last-admin protection',
      removers.some((r) => r.ok === false && r.reason === 'last_admin_protected'),
      'JSON store would fail this: each worker counted its own file');
    check('the refusal is audited durably',
      (await admin.listAudit({ limit: 500 })).some((e) => e.reason === 'last_admin_protected'));

    // ---- Test 3: concurrent grant of the SAME role from two processes ----
    console.log('\n[XW-3] concurrent identical grants produce exactly one active row');
    barrier = Date.now() + 9_000;
    const granters = await spawnWorkers(schema, barrier, [
      ['grant-role', TARGET, 'watson_support_admin', ACTOR],
      ['grant-role', TARGET, 'watson_support_admin', ACTOR],
      ['grant-role', TARGET, 'watson_support_admin', ACTOR]
    ]);
    console.log('    ' + JSON.stringify(granters));
    const rows = (await admin.allAssignments()).filter(
      (a) => a.targetOid === TARGET && a.role === 'watson_support_admin' && a.active);
    check('exactly ONE active assignment row exists despite three concurrent grants',
      rows.length === 1, `rows=${rows.length}`);
    check('at most one grant reported applied; the rest are idempotent, not errors',
      granters.filter((r) => r.applied === true).length <= 1 &&
      granters.every((r) => r.ok === true),
      JSON.stringify(granters.map((r) => ({ ok: r.ok, applied: r.applied, idempotent: r.idempotent }))));

    // ---- Test 4: a write by one process is immediately READ by another ----
    console.log('\n[XW-4] a write by one process is immediately visible to another');
    const readers = await spawnWorkers(schema, Date.now() + 2_000, [['read-roles', TARGET]]);
    console.log('    ' + JSON.stringify(readers));
    check('a separate process reads the role written by this one',
      (readers[0]?.roles ?? []).includes('watson_support_admin'),
      JSON.stringify(readers[0]));
    check('a separate process agrees on the administrator count',
      readers[0]?.admins === survivors, `${readers[0]?.admins} vs ${survivors}`);
  } finally {
    // Drop the throwaway schema so the database is left holding only migrated state.
    try {
      await (admin as unknown as { q: (t: string) => Promise<unknown> })
        .q(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      console.log(`\n  dropped throwaway schema ${schema}`);
    } catch { console.log(`\n  WARNING: could not drop schema ${schema}`); }
    await admin.close();
  }

  console.log(`\n=== CROSS-WORKER PROOF: ${pass} passed, ${fail} failed ===`);
  if (failures.length) { console.log('\nFAILURES:'); for (const f of failures) console.log('  - ' + f); }
  process.exit(fail > 0 ? 1 : 0);
}
void main();
