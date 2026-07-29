/* ============================================================
 * Watson — 021G-3 : one simulated App Service WORKER, as a separate OS process.
 * ------------------------------------------------------------
 * Two PostgresRbacStore instances inside one Node process share an event loop,
 * so a single-process test could pass for reasons that have nothing to do with
 * the database. A real second worker is a real second process with its own
 * connection pool and its own memory, which is what this is.
 *
 * Each agent waits for a wall-clock barrier before acting, so the operations
 * genuinely overlap rather than merely being issued in sequence.
 *
 * Prints ONE line of JSON on stdout. Nothing else.
 * ============================================================ */
import { PostgresRbacStore } from '../src/lib/it-agent/rbac/postgres-adapter';

async function entraToken(): Promise<string> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const { stdout } = await run('az', ['account', 'get-access-token',
    '--resource', 'https://ossrdbms-aad.database.windows.net',
    '--query', 'accessToken', '-o', 'tsv'], { shell: true, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function main(): Promise<void> {
  const [op, schema, barrierMs, ...rest] = process.argv.slice(2);
  const store = new PostgresRbacStore({
    host: process.env.WATSON_RBAC_PG_HOST!, port: 5432,
    database: process.env.WATSON_RBAC_PG_DATABASE!, user: process.env.WATSON_RBAC_PG_USER!,
    getAccessToken: entraToken, ssl: true, schema,
    connectionTimeoutMillis: 20_000, statementTimeoutMillis: 30_000, maxConnections: 3
  });
  const workerId = `pid${process.pid}`;
  let out: Record<string, unknown> = { workerId, op };
  try {
    // Warm the pool and the token BEFORE the barrier, so what overlaps is the
    // mutation itself and not two token fetches.
    await store.ensureSchema();
    await store.ping();

    const waitMs = Number(barrierMs) - Date.now();
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

    if (op === 'consume-preview') {
      const [digest, actorOid, targetOid, role] = rest;
      const r = await store.consumePreview(digest, {
        operation: 'assign', actorOid, targetOid, role
      }, Date.now());
      out = { ...out, ok: r.ok, reason: r.ok ? null : r.reason };
    } else if (op === 'revoke-admin') {
      const [targetOid, actorOid] = rest;
      const r = await store.revokeRole({
        targetOid, role: 'watson_role_admin', actorOid, actorUpn: null,
        correlationId: 'xw-' + workerId, elevatedAcknowledged: true,
        previousRoles: ['watson_role_admin'], resultingRoles: []
      });
      out = { ...out, ok: r.ok, applied: r.ok ? r.data.applied : false, reason: r.ok ? null : r.reason };
    } else if (op === 'grant-role') {
      const [targetOid, role, actorOid] = rest;
      const r = await store.grantRole({
        targetOid, targetDisplayName: null, targetUpn: null,
        role: role as 'watson_technician', source: 'administrator',
        actorOid, actorUpn: null, correlationId: 'xw-' + workerId,
        elevatedAcknowledged: true, previousRoles: [], resultingRoles: [role as 'watson_technician']
      });
      out = { ...out, ok: r.ok, applied: r.ok ? r.data.applied : false,
        idempotent: r.ok ? r.data.idempotent : null, reason: r.ok ? null : r.reason };
    } else if (op === 'read-roles') {
      const [targetOid] = rest;
      out = { ...out, roles: await store.activeRoles(targetOid), admins: await store.countActiveRoleAdmins() };
    } else {
      out = { ...out, error: 'unknown_op' };
    }
  } catch (e) {
    out = { ...out, error: (e as Error).name };
  } finally {
    await store.close();
  }
  process.stdout.write(JSON.stringify(out) + '\n');
}
void main();
