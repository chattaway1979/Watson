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
// `postgres` is PREPARED here but deliberately INERT: selecting it without an
// adapter (021G-3) fails configuration rather than pretending to be ready.
// ============================================================
import type { RbacStoreAdapter, RbacStoreKind } from './persistence';
import { JsonRbacStore } from './json-adapter';
import { MemoryRbacStore } from './memory-adapter';

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
    // 021G-3 will supply the adapter and these settings. Until then, selecting
    // postgres is a configuration FAILURE rather than a silent JSON fallback.
    if (!env.WATSON_RBAC_PG_HOST?.trim()) reasons.push('rbac_store_pg_host_missing');
    if (!env.WATSON_RBAC_PG_DATABASE?.trim()) reasons.push('rbac_store_pg_database_missing');
    reasons.push('rbac_store_pg_adapter_unavailable');
    return { ok: false, kind, reasonCodes: reasons };
  }
  return { ok: true, kind, reasonCodes: [] };
}

// One adapter per process, anchored on globalThis so Next.js module duplication
// cannot produce two RBAC worlds — the same reason the runtime state was
// anchored there in 021C-1A.
const g = globalThis as unknown as { __watsonRbacAdapter?: RbacStoreAdapter };

export function rbacStore(env: NodeJS.ProcessEnv = process.env): RbacStoreAdapter {
  if (g.__watsonRbacAdapter) return g.__watsonRbacAdapter;
  const kind = configuredStoreKind(env);
  if (kind === 'postgres') {
    // No adapter exists yet. Fail closed and loudly — never degrade to JSON.
    throw new StoreConfigurationError(
      'WATSON_RBAC_STORE=postgres is configured but the Postgres adapter is not available in this build.'
    );
  }
  g.__watsonRbacAdapter = kind === 'memory' ? new MemoryRbacStore() : new JsonRbacStore();
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
