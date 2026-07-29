// ============================================================
// Watson — 021G-2 : RBAC store selection (SERVER-ONLY)
// ------------------------------------------------------------
// Chooses the active persistence adapter. Selection is EXPLICIT and fails
// closed: an unknown store type, or `postgres` without its configuration, is a
// configuration error, never a quiet downgrade to something that happens to work.
//
// THE RULE THAT MATTERS: there is no fallback path. If a shared store is
// configured and cannot be used, RBAC fails — it does not silently serve
// process-local or legacy JSON state, because that is precisely how one worker
// ends up disagreeing with another about who is an administrator.
//
// 021G-3: `postgres` is now REAL. Selecting it builds a PostgresRbacStore that
// authenticates with a Microsoft Entra token from the App Service managed
// identity. No branch in this file can produce a password, a connection string,
// or a JSON fallback once postgres is selected.
// ============================================================
import type { RbacStoreAdapter, RbacStoreKind } from './persistence';
import { JsonRbacStore } from './json-adapter';
import { MemoryRbacStore } from './memory-adapter';
import { PostgresRbacStore, managedIdentityTokenSource } from './postgres-adapter';

export class StoreConfigurationError extends Error {}

export type ConfiguredStore = 'json' | 'memory' | 'postgres';

// Read the selected store from configuration. Absent => json, which is what the
// deployed staging app uses today and what keeps this refactor a no-op for it.
export function configuredStoreKind(env: NodeJS.ProcessEnv = process.env): ConfiguredStore {
  const raw = (env.WATSON_RBAC_STORE ?? 'json').trim().toLowerCase();
  if (raw === 'json' || raw === 'memory' || raw === 'postgres') return raw;
  throw new StoreConfigurationError(
    `WATSON_RBAC_STORE must be one of json | memory | postgres (got an unrecognised value)`
  );
}

// Validate that the selected store COULD be constructed. Used by the deployment
// configuration gate so a misconfiguration is caught before traffic, not on the
// first privileged request.
export function validateStoreConfiguration(env: NodeJS.ProcessEnv = process.env): {
  ok: boolean; kind: ConfiguredStore | 'invalid'; reasonCodes: string[];
} {
  let kind: ConfiguredStore;
  try { kind = configuredStoreKind(env); }
  catch { return { ok: false, kind: 'invalid', reasonCodes: ['rbac_store_unknown'] }; }

  if (kind === 'postgres') {
    const reasons: string[] = [];
    if (!env.WATSON_RBAC_PG_HOST?.trim()) reasons.push('rbac_store_pg_host_missing');
    if (!env.WATSON_RBAC_PG_DATABASE?.trim()) reasons.push('rbac_store_pg_database_missing');
    if (!env.WATSON_RBAC_PG_USER?.trim()) reasons.push('rbac_store_pg_user_missing');
    // A password must NEVER be how this connects. If one is configured, that is a
    // misconfiguration to refuse rather than honour: it would mean a secret is
    // sitting in application settings where Entra authentication was the point.
    if (env.WATSON_RBAC_PG_PASSWORD) reasons.push('rbac_store_pg_password_forbidden');
    return { ok: reasons.length === 0, kind, reasonCodes: reasons };
  }
  return { ok: true, kind, reasonCodes: [] };
}

// Build the Postgres adapter from configuration. Separate from rbacStore() so the
// configuration mapping is directly testable without touching the process-wide
// singleton.
export function buildPostgresStore(env: NodeJS.ProcessEnv = process.env): PostgresRbacStore {
  const v = validateStoreConfiguration(env);
  if (!v.ok) {
    // The reason CODES are safe to surface; the values behind them are not, and
    // are deliberately absent from this message.
    throw new StoreConfigurationError(
      `WATSON_RBAC_STORE=postgres is misconfigured: ${v.reasonCodes.join(', ')}`
    );
  }
  return new PostgresRbacStore({
    host: env.WATSON_RBAC_PG_HOST!.trim(),
    port: Number(env.WATSON_RBAC_PG_PORT ?? 5432),
    database: env.WATSON_RBAC_PG_DATABASE!.trim(),
    user: env.WATSON_RBAC_PG_USER!.trim(),
    // The ONLY credential path: a short-lived Entra token fetched per connection
    // from the platform-assigned managed identity. Nothing is stored.
    getAccessToken: managedIdentityTokenSource(env.WATSON_RBAC_PG_CLIENT_ID?.trim() || undefined),
    ssl: true
  });
}

// One adapter per process, anchored on globalThis so Next.js module duplication
// cannot produce two RBAC worlds — the same reason the runtime state was
// anchored there in 021C-1A.
const g = globalThis as unknown as { __watsonRbacAdapter?: RbacStoreAdapter };

export function rbacStore(env: NodeJS.ProcessEnv = process.env): RbacStoreAdapter {
  if (g.__watsonRbacAdapter) return g.__watsonRbacAdapter;
  const kind = configuredStoreKind(env);
  // buildPostgresStore THROWS on misconfiguration. That is the whole point: an
  // unusable shared store must stop RBAC, never degrade it to JSON.
  g.__watsonRbacAdapter =
    kind === 'postgres' ? buildPostgresStore(env)
    : kind === 'memory' ? new MemoryRbacStore()
    : new JsonRbacStore();
  return g.__watsonRbacAdapter;
}

// Test seam: install a specific adapter (usually the in-memory reference).
export function __setRbacStoreForTests(adapter: RbacStoreAdapter | null): void {
  if (adapter === null) delete g.__watsonRbacAdapter;
  else g.__watsonRbacAdapter = adapter;
}

// Safe provenance for /api/health. Reports the store TYPE only — never a host,
// database name, user, or connection string.
export function rbacStoreProvenance(env: NodeJS.ProcessEnv = process.env): {
  store: RbacStoreKind | 'invalid';
  multiInstanceSafe: boolean;
} {
  let kind: ConfiguredStore | 'invalid';
  try { kind = configuredStoreKind(env); } catch { kind = 'invalid'; }
  if (kind === 'invalid') return { store: 'invalid', multiInstanceSafe: false };
  const store: RbacStoreKind = kind === 'json' ? 'json_legacy' : kind === 'memory' ? 'memory' : 'postgres';
  // Only a shared database is multi-instance safe. The JSON adapter is NOT, and
  // this must never report otherwise.
  return { store, multiInstanceSafe: store === 'postgres' };
}
