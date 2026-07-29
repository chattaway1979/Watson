/* ============================================================
 * Watson — 021G-3 : the same contract suite, executed against the REAL Azure
 * Database for PostgreSQL over Microsoft Entra token authentication.
 * ------------------------------------------------------------
 * The local-container run proves the SQL and the locking. This run additionally
 * proves the credential path: no password exists on that server, so every
 * connection below succeeds only because a short-lived Entra token was accepted.
 *
 * The token is obtained from the ambient Azure CLI login for this operator run.
 * In the deployed app the equivalent token comes from the App Service managed
 * identity via managedIdentityTokenSource(). Neither is ever printed or stored.
 * ============================================================ */
import { runRbacPersistenceTests } from './rbac-persistence-021g.selftest';
import type { ContractDriver, ContractStore } from './rbac-persistence-021g.selftest';
import { PostgresRbacStore, type PostgresStoreConfig } from '../src/lib/it-agent/rbac/postgres-adapter';

async function entraToken(): Promise<string> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const { stdout } = await run('az', [
    'account', 'get-access-token',
    '--resource', 'https://ossrdbms-aad.database.windows.net',
    '--query', 'accessToken', '-o', 'tsv'
  ], { shell: true, maxBuffer: 1024 * 1024 });
  const t = stdout.trim();
  if (!t) throw new Error('token_unavailable');
  return t;
}

async function main(): Promise<void> {
  const host = process.env.WATSON_RBAC_PG_HOST;
  const database = process.env.WATSON_RBAC_PG_DATABASE;
  const user = process.env.WATSON_RBAC_PG_USER;
  if (!host || !database || !user) {
    console.log('SKIPPED: WATSON_RBAC_PG_HOST / _DATABASE / _USER not set');
    process.exit(1);
  }

  let schemaSeq = 0;
  const runId = 'az' + Math.random().toString(36).slice(2, 7);
  const open: PostgresRbacStore[] = [];
  const base = (schema?: string): PostgresStoreConfig => ({
    host, database, user, port: Number(process.env.WATSON_RBAC_PG_PORT ?? 5432),
    getAccessToken: entraToken, ssl: true, schema,
    connectionTimeoutMillis: 15_000, statementTimeoutMillis: 30_000, maxConnections: 10
  });

  const drv: ContractDriver = {
    label: 'Azure Database for PostgreSQL (Entra token auth, no password)',
    kind: 'postgres',
    make: async () => {
      const s = new PostgresRbacStore(base(`wt_${runId}_${++schemaSeq}`));
      await s.ensureSchema();
      open.push(s);
      return s as unknown as ContractStore;
    },
    unavailableStore: async () => {
      const s = new PostgresRbacStore({ ...base(), host: '127.0.0.1', port: 1, ssl: false,
        connectionTimeoutMillis: 1_500 });
      open.push(s);
      return s;
    },
    dispose: async () => { for (const s of open) await s.close(); }
  };

  console.log(`\n=== CONTRACT AGAINST AZURE POSTGRES — ${drv.label} ===`);
  let r;
  try { r = await runRbacPersistenceTests(drv); }
  finally { await drv.dispose?.(); }

  console.log(`\n=== AZURE POSTGRES CONTRACT: ${r.pass} passed, ${r.fail} failed ===`);
  if (r.failures.length) { console.log('\nFAILURES:'); for (const f of r.failures) console.log('  - ' + f); }

  // Clean up the throwaway schemas this run created, so the database is left
  // holding only what the migration will put there.
  const admin = new PostgresRbacStore(base());
  try {
    const rows = await (admin as unknown as {
      q: <T>(t: string, v?: unknown[]) => Promise<T[]>;
    }).q<{ nspname: string }>(
      `SELECT nspname FROM pg_namespace WHERE nspname LIKE $1`, [`wt_${runId}_%`]);
    for (const s of rows) {
      await (admin as unknown as { q: (t: string) => Promise<unknown> })
        .q(`DROP SCHEMA IF EXISTS ${s.nspname} CASCADE`);
    }
    console.log(`  cleaned up ${rows.length} throwaway test schema(s)`);
  } catch {
    console.log('  WARNING: throwaway schema cleanup did not complete');
  } finally { await admin.close(); }

  process.exit(r.fail > 0 ? 1 : 0);
}
void main();
