/* ============================================================
 * Watson — 021G-3 : the RBAC contract suite, executed against REAL PostgreSQL.
 * ------------------------------------------------------------
 * This is the gate that has to pass BEFORE any Azure provisioning, migration or
 * cutover happens. It does not restate the contract — it imports the very same
 * assertion function the in-memory reference runs (`runRbacPersistenceTests`)
 * and points it at a PostgresRbacStore. There is exactly one copy of those
 * assertions in the repository, so "passes against Postgres" cannot quietly mean
 * "passes against a weaker Postgres-flavoured variant".
 *
 * Every block gets its OWN schema inside the test database, so the blocks are
 * isolated from one another exactly as separate MemoryRbacStore instances are.
 *
 * Connection details come from WATSON_PG_TEST_* and are never written to source,
 * logs or reports. When they are absent this suite SKIPS rather than fails, so
 * `npm run it-agent:selftest` stays deterministic and database-free by default.
 * A skip is reported as a skip and never counted as a pass.
 * ============================================================ */
import { runRbacPersistenceTests, type ContractDriver, type ContractStore } from './rbac-persistence-021g.selftest';
import { PostgresRbacStore, type PostgresStoreConfig } from '../src/lib/it-agent/rbac/postgres-adapter';

export interface PgTestTarget {
  host: string; port: number; database: string; user: string; password: string;
}

/** Reads the opt-in test target. Absent => the suite skips. */
export function pgTestTarget(env = process.env): PgTestTarget | null {
  const host = env.WATSON_PG_TEST_HOST;
  const database = env.WATSON_PG_TEST_DB;
  const user = env.WATSON_PG_TEST_USER;
  if (!host || !database || !user) return null;
  return {
    host, database, user,
    port: Number(env.WATSON_PG_TEST_PORT ?? 5432),
    // Local throwaway container only. Production authenticates with a Microsoft
    // Entra token from the App Service managed identity and has no password at
    // all — see managedIdentityTokenSource in the adapter.
    password: env.WATSON_PG_TEST_PASSWORD ?? ''
  };
}

let schemaSeq = 0;

export function postgresDriver(t: PgTestTarget, runId: string): ContractDriver {
  const open: PostgresRbacStore[] = [];
  const base = (schema?: string): PostgresStoreConfig => ({
    host: t.host, port: t.port, database: t.database, user: t.user,
    getAccessToken: async () => t.password,
    ssl: false, schema,
    connectionTimeoutMillis: 5_000, statementTimeoutMillis: 20_000, maxConnections: 12
  });
  return {
    label: 'PostgreSQL (real transactions)',
    kind: 'postgres',
    make: async () => {
      // A fresh schema per store: the same isolation `new MemoryRbacStore()` gives.
      const s = new PostgresRbacStore(base(`wt_${runId}_${++schemaSeq}`));
      await s.ensureSchema();
      open.push(s);
      return s as unknown as ContractStore;
    },
    unavailableStore: async () => {
      // GENUINELY unreachable — a port with nothing listening — rather than a
      // flag that makes the adapter pretend. The failure has to come from the
      // real connection path or the assertion proves nothing.
      const s = new PostgresRbacStore({ ...base(), host: '127.0.0.1', port: 1,
        connectionTimeoutMillis: 1_500 });
      open.push(s);
      return s;
    },
    dispose: async () => { for (const s of open) await s.close(); }
  };
}

export async function runRbacPostgresContractTests(): Promise<{ pass: number; fail: number; failures: string[]; skipped: boolean }> {
  const t = pgTestTarget();
  if (!t) {
    console.log('\n[132] RBAC contract against real PostgreSQL — SKIPPED (WATSON_PG_TEST_* not set)');
    console.log('  ⏭  not counted as passing; run scripts/run-pg-contract.ts to execute it');
    return { pass: 0, fail: 0, failures: [], skipped: true };
  }

  const runId = Math.random().toString(36).slice(2, 8);
  const drv = postgresDriver(t, runId);
  console.log(`\n[132] RBAC contract against real PostgreSQL — ${drv.label}`);

  let pass = 0, fail = 0; const failures: string[] = [];
  try {
    const r = await runRbacPersistenceTests(drv);
    pass += r.pass; fail += r.fail; failures.push(...r.failures.map((f) => '[postgres] ' + f));
  } finally {
    await drv.dispose?.();
  }

  // The deterministic structure/leakage assertions for this adapter live in
  // rbac-postgres-021g3.selftest.ts and run on every self-test, so they are not
  // duplicated here. This suite exists purely for the BEHAVIOURAL proof.
  return { pass, fail, failures, skipped: false };
}
