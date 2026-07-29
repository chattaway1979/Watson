// ============================================================
// Watson — 021G-3 : PostgreSQL RBAC store adapter (SERVER-ONLY)
// ------------------------------------------------------------
// The durable, multi-worker implementation of the persistence contract. The
// in-memory adapter is the REFERENCE for these semantics; this file must behave
// identically, and the same unchanged contract suite is run against both to
// prove it (`scripts/rbac-postgres-contract-021g3.selftest.ts`).
//
// ISOLATION AND LOCKING MODEL
// Transactions run at READ COMMITTED (the PostgreSQL default). Serialisable
// would also be correct but would surface as retryable serialisation failures on
// a security path, and "retry the removal of an administrator" is a worse
// failure mode than blocking briefly. Instead the invariants are pinned by
// explicit locks:
//
//   * THE ADMINISTRATOR SET.  Every operation that can change the number of
//     Watson role administrators — granting watson_role_admin, revoking it, and
//     bootstrap — first takes the transaction-scoped advisory lock
//     ADMIN_SET_LOCK. That makes those operations totally ordered with respect
//     to one another across every worker and every connection, so the
//     count-then-act sequence inside revokeRole cannot interleave with another
//     removal. Relying on `SELECT ... FOR UPDATE` alone would ALMOST work, but
//     its correctness would rest on EvalPlanQual re-checking a row a concurrent
//     transaction just deactivated. The advisory lock does not depend on that
//     reasoning, and final-administrator protection is not a place to be subtle.
//     The lock is transaction-scoped (`pg_advisory_xact_lock`), so it is always
//     released on COMMIT or ROLLBACK — including a connection drop.
//
//   * A SINGLE ASSIGNMENT ROW.  Mutations lock the specific assignment with
//     `FOR UPDATE`, and a partial UNIQUE index makes a second ACTIVE row for the
//     same principal+role impossible even if application logic were wrong.
//
//   * A NONCE.  consumePreview locks its row `FOR UPDATE` and consumes with a
//     conditional UPDATE guarded by `consumed_at IS NULL`. Two concurrent
//     confirmations of one nonce therefore produce exactly one mutation, across
//     workers, because the guard lives in the database rather than in a Map.
//
// CREDENTIALS
// This adapter never accepts, stores, logs or returns a password. Against Azure
// Database for PostgreSQL it authenticates with a Microsoft Entra access token
// obtained from the App Service managed identity, supplied through pg's
// `password` callback so the token is passed straight to the driver and is never
// placed in a connection string, an environment variable, a log line or an
// error. Tokens are cached in memory only, and refreshed before expiry.
//
// ERRORS
// No driver message, SQL fragment, host name or credential ever leaves this
// file. Failures are mapped to the contract's safe categories.
// ============================================================
import type { Pool, PoolClient } from 'pg';
import type { WatsonRoleKey } from './roles';
import type { RoleAssignment, RbacAuditEvent, AssignmentSource } from './store';
import type {
  RbacStoreAdapter, PersistenceResult, MutationOutcome, GrantInput, RevokeInput,
  PreviewRecord, PreviewBinding, PreviewConsume, BootstrapOutcome, PersistenceFailure
} from './persistence';

// A stable 64-bit key for the administrator-set advisory lock. Constant, so
// every worker in every process contends on the SAME lock.
const ADMIN_SET_LOCK = 7_020_930_331_001n;

let seq = 0;
const nextId = (p: string) => `${p}-${Date.now().toString(36)}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export interface PostgresStoreConfig {
  host: string;
  database: string;
  port?: number;
  /** Entra principal used for the login role. For managed identity this is the
   *  identity's name, never a secret. */
  user: string;
  /** Supplies a fresh Entra access token. Never a stored password. */
  getAccessToken: () => Promise<string>;
  ssl?: boolean;
  /** Bound so a database outage fails the service closed promptly rather than
   *  hanging a request thread until the platform times it out. */
  connectionTimeoutMillis?: number;
  statementTimeoutMillis?: number;
  maxConnections?: number;
  /** Optional search_path. Used by the contract suite to give each block its own
   *  schema inside one database; production leaves it unset and uses `public`. */
  schema?: string;
}

/** Azure token acquisition, isolated so it can be substituted in tests without
 *  the adapter ever learning what a credential looks like. */
export function managedIdentityTokenSource(clientId?: string): () => Promise<string> {
  let cached: { token: string; expiresOnMs: number } | null = null;
  return async () => {
    // Refresh two minutes early: a token that expires mid-transaction would
    // surface as an authentication failure on a security path.
    if (cached && cached.expiresOnMs - Date.now() > 120_000) return cached.token;
    const { ManagedIdentityCredential } = await import('@azure/identity');
    const cred = clientId ? new ManagedIdentityCredential({ clientId }) : new ManagedIdentityCredential();
    // The OSS PostgreSQL AAD audience. Documented and stable.
    const t = await cred.getToken('https://ossrdbms-aad.database.windows.net/.default');
    if (!t?.token) throw new Error('token_unavailable');
    cached = { token: t.token, expiresOnMs: t.expiresOnTimestamp ?? Date.now() + 300_000 };
    return cached.token;
  };
}

export class PostgresRbacStore implements RbacStoreAdapter {
  readonly kind = 'postgres' as const;
  private pool: Pool | null = null;
  private ready: Promise<void> | null = null;
  private readonly cfg: PostgresStoreConfig;

  constructor(cfg: PostgresStoreConfig) {
    this.cfg = cfg;
  }

  // ---- connection + schema ----------------------------------------------
  private async getPool(): Promise<Pool> {
    if (this.pool) return this.pool;
    const pg = await import('pg');
    const PoolCtor = (pg.default ?? pg).Pool;
    this.pool = new PoolCtor({
      host: this.cfg.host,
      port: this.cfg.port ?? 5432,
      database: this.cfg.database,
      user: this.cfg.user,
      // A CALLBACK, not a value: the token is fetched per connection and never
      // materialised anywhere this process can log it.
      password: this.cfg.getAccessToken,
      ssl: this.cfg.ssl === false ? undefined : { rejectUnauthorized: true },
      max: this.cfg.maxConnections ?? 8,
      connectionTimeoutMillis: this.cfg.connectionTimeoutMillis ?? 8_000,
      idleTimeoutMillis: 30_000,
      // Bounds a pathological query rather than holding a lock indefinitely.
      statement_timeout: this.cfg.statementTimeoutMillis ?? 15_000,
      application_name: 'watson-rbac',
      ...(this.cfg.schema ? { options: `-c search_path=${quoteIdent(this.cfg.schema)}` } : {})
    });
    // A pool 'error' on an idle client is normal (server closed it); swallowing
    // it without a message keeps a host name out of the logs.
    this.pool.on('error', () => {});
    return this.pool;
  }

  /** Applies the schema. Idempotent; runs at most once per process. */
  async ensureSchema(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        const { readFile } = await import('node:fs/promises');
        const { fileURLToPath } = await import('node:url');
        const path = await import('node:path');
        const here = path.dirname(fileURLToPath(import.meta.url));
        let sql: string;
        try {
          sql = await readFile(path.join(here, 'postgres-schema.sql'), 'utf8');
        } catch {
          // In a bundled build the .sql file may not sit beside the module.
          sql = EMBEDDED_SCHEMA;
        }
        const pool = await this.getPool();
        // When a schema is configured the connection's search_path already points
        // at it, so the schema has to exist before the DDL below can land in it.
        if (this.cfg.schema) await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(this.cfg.schema)}`);
        try {
          await pool.query(sql);
        } catch (ddlError) {
          // THE APPLICATION SHOULD NOT NEED DDL RIGHTS. In the deployed
          // environment the schema is applied out-of-band by an administrator and
          // the managed identity holds only SELECT/INSERT/UPDATE — which is the
          // posture we want, because an application that can DROP its own audit
          // table is one bug away from destroying the evidence.
          //
          // So a failed DDL attempt is not automatically fatal: what matters is
          // whether the schema is ALREADY THERE. Verify that directly. If it is,
          // this store is ready. If it is not, the original error stands.
          try {
            await pool.query('SELECT 1 FROM rbac_assignment LIMIT 0');
            await pool.query('SELECT 1 FROM rbac_audit LIMIT 0');
            await pool.query('SELECT 1 FROM rbac_preview_nonce LIMIT 0');
          } catch {
            throw ddlError;
          }
        }
      })().catch((e) => { this.ready = null; throw e; });
    }
    return this.ready;
  }

  async close(): Promise<void> {
    const p = this.pool;
    this.pool = null; this.ready = null;
    if (p) await p.end().catch(() => {});
  }

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    await this.ensureSchema();
    const pool = await this.getPool();
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  private async q<T = unknown>(text: string, values: unknown[] = []): Promise<T[]> {
    await this.ensureSchema();
    const pool = await this.getPool();
    const r = await pool.query(text, values);
    return r.rows as T[];
  }

  /** Every driver error becomes a safe category here and nowhere else. */
  private static classify(e: unknown): PersistenceFailure {
    // The injected faults are ours, so they are recognised before anything else
    // and never confused with a real database condition.
    const msg = (e as Error | null)?.message;
    if (msg === 'audit') return 'audit_failure';
    if (msg === 'assignment') return 'persistence_failure';

    const code = (e as { code?: string } | null)?.code;
    // A PostgreSQL SQLSTATE is always five alphanumeric characters. Anything
    // else — ECONNREFUSED, ETIMEDOUT, ENOTFOUND, a pool timeout with no code —
    // is the store being unreachable, NOT a statement that failed. Getting this
    // wrong would report an outage as a persistence bug and vice versa.
    if (!code || !/^[0-9A-Z]{5}$/.test(code)) return 'store_unavailable';
    if (code === '23505') return 'conflict';
    if (code === '40001' || code === '40P01') return 'conflict';   // serialisation / deadlock
    if (/^(08|53|57|58|XX)/.test(code)) return 'store_unavailable'; // connection, resource, operator intervention
    if (/^(28|42)/.test(code)) return 'store_unavailable';          // auth failure, missing relation => misconfigured
    return 'persistence_failure';
  }

  async ping(): Promise<boolean> {
    try { await this.q('SELECT 1'); return true; } catch { return false; }
  }

  /** Which STAGE of bringing the store up fails, and in which safe category.
   *
   *  ping() answers yes/no, which is the right contract for the security core but
   *  useless to an operator: "the database is unreachable" and "the managed
   *  identity has no rights on the audit table" need completely different fixes.
   *  This reports the phase and the classified category and NOTHING else — no
   *  driver message, no SQLSTATE, no host, no user, no token. */
  /** A coarse, SAFE cause for a failed connection. "store_unavailable" is the
   *  right thing to tell the security core but it collapses three completely
   *  different operator actions — fix the identity's database role, fix TLS
   *  trust, fix the firewall — into one word. These labels are derived from
   *  error CODES only and contain no host, user, message or SQLSTATE. */
  private static cause(e: unknown): string {
    const code = String((e as { code?: string } | null)?.code ?? '');
    if (/^28/.test(code)) return 'auth_rejected';          // invalid authorization / bad password
    if (/^3D/.test(code)) return 'database_absent';
    if (/^42/.test(code)) return 'insufficient_privilege_or_missing_relation';
    if (code === 'ECONNREFUSED') return 'refused';
    if (code === 'ETIMEDOUT' || code === 'ECONNRESET') return 'network_timeout';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns_failure';
    if (/CERT|TLS|SSL|DEPTH_ZERO|SELF_SIGNED/i.test(code)) return 'tls_untrusted';
    const msg = String((e as Error | null)?.message ?? '');
    // pg reports a pool acquisition timeout with no code.
    if (/timeout/i.test(msg)) return 'connect_timeout';
    if (/certificate|self.signed|unable to verify/i.test(msg)) return 'tls_untrusted';
    if (/password|authentication/i.test(msg)) return 'auth_rejected';
    return 'unknown';
  }

  async probe(): Promise<{
    ok: boolean;
    phase: 'token' | 'connect' | 'schema' | 'query' | 'none';
    category: PersistenceFailure | 'ok';
    cause?: string;
  }> {
    // 1. Can the identity get a token at all? This isolates a platform/identity
    //    problem from a database problem.
    try {
      const t = await this.cfg.getAccessToken();
      if (!t) return { ok: false, phase: 'token', category: 'store_unavailable', cause: 'token_empty' };
    } catch (e) {
      return { ok: false, phase: 'token', category: 'store_unavailable', cause: PostgresRbacStore.cause(e) };
    }
    // 2. Can a connection be established and authenticated?
    try {
      const pool = await this.getPool();
      const c = await pool.connect();
      try { await c.query('SELECT 1'); } finally { c.release(); }
    } catch (e) {
      return { ok: false, phase: 'connect', category: PostgresRbacStore.classify(e), cause: PostgresRbacStore.cause(e) };
    }
    // 3. Does the schema apply? (A privilege gap shows up here, not at connect.)
    try {
      await this.ensureSchema();
    } catch (e) {
      return { ok: false, phase: 'schema', category: PostgresRbacStore.classify(e), cause: PostgresRbacStore.cause(e) };
    }
    // 4. Can the RBAC tables actually be read?
    try {
      await this.q('SELECT 1 FROM rbac_assignment LIMIT 1');
    } catch (e) {
      return { ok: false, phase: 'query', category: PostgresRbacStore.classify(e), cause: PostgresRbacStore.cause(e) };
    }
    return { ok: true, phase: 'none', category: 'ok' };
  }

  // ---- reads --------------------------------------------------------------
  async activeRoles(oid: string): Promise<WatsonRoleKey[]> {
    const rows = await this.q<{ role: WatsonRoleKey }>(
      'SELECT DISTINCT role FROM rbac_assignment WHERE principal_object_id = $1 AND active ORDER BY role', [oid]);
    return rows.map((r) => r.role);
  }

  async activeAssignments(oid: string): Promise<RoleAssignment[]> {
    const rows = await this.q<AssignmentRow>(
      `SELECT * FROM rbac_assignment WHERE principal_object_id = $1 AND active ORDER BY assigned_at`, [oid]);
    return rows.map(mapAssignment);
  }

  async countActiveRoleAdmins(): Promise<number> {
    const rows = await this.q<{ n: string }>(
      `SELECT COUNT(DISTINCT principal_object_id)::text AS n FROM rbac_assignment
        WHERE active AND role = 'watson_role_admin'`);
    return Number(rows[0]?.n ?? 0);
  }

  async roleStateVersion(oid: string): Promise<number> {
    // Sums EVERY row for the principal, active or not, so a removal moves the
    // version just as an addition does — a preview taken before a removal must
    // not confirm after it.
    const rows = await this.q<{ v: string | null }>(
      'SELECT COALESCE(SUM(version),0)::text AS v FROM rbac_assignment WHERE principal_object_id = $1', [oid]);
    return Number(rows[0]?.v ?? 0);
  }

  async listAudit(filter: { targetOid?: string; limit?: number } = {}): Promise<RbacAuditEvent[]> {
    const limit = Math.min(filter.limit ?? 100, 500);
    const rows = filter.targetOid
      ? await this.q<AuditRow>(
          'SELECT * FROM rbac_audit WHERE target_object_id = $1 ORDER BY created_at DESC, audit_id DESC LIMIT $2',
          [filter.targetOid, limit])
      : await this.q<AuditRow>(
          'SELECT * FROM rbac_audit ORDER BY created_at DESC, audit_id DESC LIMIT $1', [limit]);
    return rows.map(mapAudit);
  }

  // ---- audit-only append --------------------------------------------------
  async appendAudit(e: Omit<RbacAuditEvent, 'id' | 'at'>): Promise<PersistenceResult<void>> {
    try {
      const pool = await this.getPoolReady();
      await insertAudit(pool, e);
      return { ok: true, data: undefined };
    } catch (err) {
      return { ok: false, reason: PostgresRbacStore.classify(err) };
    }
  }

  private async getPoolReady(): Promise<PoolClient | Pool> {
    await this.ensureSchema();
    return this.getPool();
  }

  // ---- atomic grant -------------------------------------------------------
  async grantRole(i: GrantInput): Promise<PersistenceResult<MutationOutcome>> {
    try {
      return await this.tx(async (c) => {
        // Granting watson_role_admin CHANGES the administrator set, so it takes
        // the same lock a removal does; otherwise a grant could land between a
        // removal's count and its write.
        if (i.role === 'watson_role_admin') await lockAdminSet(c);
        if (i.inject?.failAssignmentWrite) throw new Error('assignment');

        const existing = await c.query(
          `SELECT assignment_id FROM rbac_assignment
            WHERE principal_object_id = $1 AND role = $2 AND active FOR UPDATE`, [i.targetOid, i.role]);

        if (existing.rowCount) {
          // Idempotent: an already-held role never produces a second active row.
          await insertAudit(c, {
            correlationId: i.correlationId, actorOid: i.actorOid, actorUpn: i.actorUpn,
            targetOid: i.targetOid, operation: 'assign_confirm', outcome: 'success',
            reason: 'idempotent_already_assigned', previousRoles: i.previousRoles,
            resultingRoles: i.previousRoles, source: 'administrator',
            elevatedAcknowledged: i.elevatedAcknowledged
          });
          return { ok: true as const, data: { applied: false, idempotent: true, roles: await rolesIn(c, i.targetOid) } };
        }

        await c.query(
          `INSERT INTO rbac_assignment (
             assignment_id, principal_object_id, role, active, assignment_source,
             target_display_name, target_upn, assigned_by_object_id, assigned_at,
             modified_at, modified_by_object_id, version)
           VALUES ($1,$2,$3,TRUE,$4,$5,$6,$7,now(),now(),$7,1)`,
          [nextId('asg'), i.targetOid, i.role, i.source, i.targetDisplayName, i.targetUpn, i.actorOid]);

        // Injected AFTER the assignment write and BEFORE the commit, so the
        // rollback that follows is the real transactional one.
        if (i.inject?.failAuditWrite) throw new Error('audit');

        await insertAudit(c, {
          correlationId: i.correlationId, actorOid: i.actorOid, actorUpn: i.actorUpn,
          targetOid: i.targetOid, operation: 'assign_confirm', outcome: 'success',
          reason: 'role_assigned', previousRoles: i.previousRoles, resultingRoles: i.resultingRoles,
          source: i.source, elevatedAcknowledged: i.elevatedAcknowledged
        });
        return { ok: true as const, data: { applied: true, idempotent: false, roles: await rolesIn(c, i.targetOid) } };
      });
    } catch (e) {
      // A unique violation means a concurrent grant of the same role won the
      // race. The end state is exactly what the caller asked for, so this is
      // reported the way the reference adapter reports it: idempotent.
      if ((e as { code?: string }).code === '23505') {
        try {
          return { ok: true, data: { applied: false, idempotent: true, roles: await this.activeRoles(i.targetOid) } };
        } catch { /* fall through to the failure below */ }
      }
      return { ok: false, reason: PostgresRbacStore.classify(e) };
    }
  }

  // ---- atomic revoke, WITH final-admin protection inside the boundary ------
  async revokeRole(i: RevokeInput): Promise<PersistenceResult<MutationOutcome>> {
    try {
      return await this.tx(async (c) => {
        // Taken BEFORE anything is read. Everything below — the count and the
        // write that depends on it — is therefore serialised against every other
        // administrator-set mutation in the cluster.
        if (i.role === 'watson_role_admin') await lockAdminSet(c);

        const existing = await c.query(
          `SELECT assignment_id FROM rbac_assignment
            WHERE principal_object_id = $1 AND role = $2 AND active FOR UPDATE`, [i.targetOid, i.role]);

        if (!existing.rowCount) {
          await insertAudit(c, {
            correlationId: i.correlationId, actorOid: i.actorOid, actorUpn: i.actorUpn,
            targetOid: i.targetOid, operation: 'remove_confirm', outcome: 'success',
            reason: 'idempotent_not_assigned', previousRoles: i.previousRoles,
            resultingRoles: i.previousRoles, source: 'administrator',
            elevatedAcknowledged: i.elevatedAcknowledged
          });
          return { ok: true as const, data: { applied: false, idempotent: true, roles: await rolesIn(c, i.targetOid) } };
        }

        // THE INVARIANT. Counted under the advisory lock and acted upon in the
        // same transaction, so two concurrent removals cannot both observe two
        // administrators and both proceed.
        if (i.role === 'watson_role_admin') {
          const n = await c.query<{ n: string }>(
            `SELECT COUNT(DISTINCT principal_object_id)::text AS n FROM rbac_assignment
              WHERE active AND role = 'watson_role_admin'`);
          if (Number(n.rows[0]?.n ?? 0) <= 1) {
            await insertAudit(c, {
              correlationId: i.correlationId, actorOid: i.actorOid, actorUpn: i.actorUpn,
              targetOid: i.targetOid, operation: 'remove_confirm', outcome: 'refused',
              reason: 'last_admin_protected', previousRoles: i.previousRoles,
              resultingRoles: i.previousRoles, source: 'administrator',
              elevatedAcknowledged: i.elevatedAcknowledged
            });
            // The refusal audit row must survive, so this commits rather than
            // rolling back — the refusal IS the outcome, not an error.
            return { ok: false as const, reason: 'last_admin_protected' as const };
          }
        }

        if (i.inject?.failAssignmentWrite) throw new Error('assignment');
        await c.query(
          `UPDATE rbac_assignment
              SET active = FALSE, removed_at = now(), removed_by_object_id = $3,
                  modified_at = now(), modified_by_object_id = $3, version = version + 1
            WHERE principal_object_id = $1 AND role = $2 AND active`, [i.targetOid, i.role, i.actorOid]);
        if (i.inject?.failAuditWrite) throw new Error('audit');
        await insertAudit(c, {
          correlationId: i.correlationId, actorOid: i.actorOid, actorUpn: i.actorUpn,
          targetOid: i.targetOid, operation: 'remove_confirm', outcome: 'success',
          reason: 'role_removed', previousRoles: i.previousRoles, resultingRoles: i.resultingRoles,
          source: 'administrator', elevatedAcknowledged: i.elevatedAcknowledged
        });
        return { ok: true as const, data: { applied: true, idempotent: false, roles: await rolesIn(c, i.targetOid) } };
      });
    } catch (e) {
      return { ok: false, reason: PostgresRbacStore.classify(e) };
    }
  }

  // ---- previews -----------------------------------------------------------
  async putPreview(r: PreviewRecord): Promise<PersistenceResult<void>> {
    try {
      await this.q(
        `INSERT INTO rbac_preview_nonce (
           nonce_digest, action, actor_object_id, target_object_id, role,
           state_version, elevated_required, payload, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (nonce_digest) DO NOTHING`,
        [r.digest, r.operation, r.actorOid, r.targetOid, r.role, r.stateVersion,
         r.elevatedRequired, r.payload, new Date(r.expiresAt).toISOString()]);
      return { ok: true, data: undefined };
    } catch (e) {
      return { ok: false, reason: PostgresRbacStore.classify(e) };
    }
  }

  async consumePreview(digest: string, b: PreviewBinding, nowMs: number): Promise<PreviewConsume> {
    return this.tx(async (c) => {
      // FOR UPDATE serialises concurrent confirmations of THIS nonce across
      // every worker; the `consumed_at IS NULL` guard on the UPDATE is what
      // actually makes it single-use.
      const found = await c.query<NonceRow>(
        'SELECT * FROM rbac_preview_nonce WHERE nonce_digest = $1 FOR UPDATE', [digest]);
      const p = found.rows[0];
      // An unknown digest is 'stale' — deliberately indistinguishable from
      // expired, so a caller cannot probe for which nonces exist.
      if (!p || p.action !== b.operation) return { ok: false as const, reason: 'stale_preview' as const };
      if (p.consumed_at) return { ok: false as const, reason: 'replayed_preview' as const };
      if (Date.parse(iso(p.expires_at)) <= nowMs) return { ok: false as const, reason: 'stale_preview' as const };
      if (p.actor_object_id !== b.actorOid) return { ok: false as const, reason: 'actor_mismatch' as const };
      if (p.target_object_id !== b.targetOid) return { ok: false as const, reason: 'target_mismatch' as const };
      if (p.role !== b.role) return { ok: false as const, reason: 'role_mismatch' as const };
      // Time-of-check/time-of-use: the target's roles must not have moved. Read
      // INSIDE the transaction so a concurrent grant cannot slip between.
      let current = b.expectedStateVersion;
      if (current === undefined) {
        const v = await c.query<{ v: string }>(
          'SELECT COALESCE(SUM(version),0)::text AS v FROM rbac_assignment WHERE principal_object_id = $1',
          [p.target_object_id]);
        current = Number(v.rows[0]?.v ?? 0);
      }
      if (current !== p.state_version) return { ok: false as const, reason: 'stale_preview' as const };

      // Nothing above mutates, so a binding failure leaves the nonce usable by
      // its legitimate holder — matching the reference adapter exactly.
      const consumed = await c.query(
        'UPDATE rbac_preview_nonce SET consumed_at = now() WHERE nonce_digest = $1 AND consumed_at IS NULL',
        [digest]);
      if (!consumed.rowCount) return { ok: false as const, reason: 'replayed_preview' as const };
      return { ok: true as const, record: mapPreview(p) };
    }).catch(() => ({ ok: false as const, reason: 'stale_preview' as const }));
  }

  async purgeExpiredPreviews(nowMs: number): Promise<number> {
    const r = await this.q<{ n: string }>(
      `WITH d AS (DELETE FROM rbac_preview_nonce
                   WHERE expires_at <= $1 OR consumed_at IS NOT NULL RETURNING 1)
       SELECT COUNT(*)::text AS n FROM d`, [new Date(nowMs).toISOString()]);
    return Number(r[0]?.n ?? 0);
  }

  // ---- bootstrap ----------------------------------------------------------
  async tryBootstrap(oid: string, correlationId: string): Promise<PersistenceResult<BootstrapOutcome>> {
    try {
      return await this.tx(async (c) => {
        await lockAdminSet(c);   // count-and-create, serialised cluster-wide
        const n = await c.query<{ n: string }>(
          `SELECT COUNT(DISTINCT principal_object_id)::text AS n FROM rbac_assignment
            WHERE active AND role = 'watson_role_admin'`);
        if (Number(n.rows[0]?.n ?? 0) > 0) {
          await insertAudit(c, {
            correlationId, actorOid: 'system:bootstrap', actorUpn: null, targetOid: oid,
            operation: 'bootstrap', outcome: 'refused', reason: 'persistent_admin_exists',
            previousRoles: null, resultingRoles: null, source: 'bootstrap', elevatedAcknowledged: null
          });
          return { ok: true as const, data: { applied: false, reason: 'persistent_admin_exists' as const } };
        }
        await c.query(
          `INSERT INTO rbac_assignment (
             assignment_id, principal_object_id, role, active, assignment_source,
             assigned_by_object_id, assigned_at, modified_at, modified_by_object_id, version)
           VALUES ($1,$2,'watson_role_admin',TRUE,'bootstrap','system:bootstrap',now(),now(),'system:bootstrap',1)`,
          [nextId('asg'), oid]);
        await c.query(
          `INSERT INTO rbac_bootstrap_state (singleton, bootstrap_oid)
           VALUES (TRUE,$1) ON CONFLICT (singleton) DO NOTHING`, [oid]);
        await insertAudit(c, {
          correlationId, actorOid: 'system:bootstrap', actorUpn: null, targetOid: oid,
          operation: 'bootstrap', outcome: 'success', reason: 'bootstrap_role_admin_created',
          previousRoles: [], resultingRoles: ['watson_role_admin'], source: 'bootstrap',
          elevatedAcknowledged: null
        });
        return { ok: true as const, data: { applied: true, reason: 'bootstrap_role_admin_created' as const } };
      });
    } catch (e) {
      return { ok: false, reason: PostgresRbacStore.classify(e) };
    }
  }

  // ---- migration support --------------------------------------------------
  // Identity-keyed, so a rerun inserts nothing rather than duplicating.
  async importAssignment(a: RoleAssignment): Promise<'inserted' | 'skipped'> {
    const r = await this.q(
      `INSERT INTO rbac_assignment (
         assignment_id, principal_object_id, role, active, assignment_source,
         target_display_name, target_upn, assigned_by_object_id, assigned_at,
         modified_at, modified_by_object_id, removed_at, removed_by_object_id, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (assignment_id) DO NOTHING RETURNING assignment_id`,
      [a.assignmentId, a.targetOid, a.role, a.active, a.source, a.targetDisplayName, a.targetUpn,
       a.assignedByOid, a.assignedAt, a.modifiedAt, a.modifiedByOid, a.removedAt, a.removedByOid, a.version]);
    return r.length ? 'inserted' : 'skipped';
  }

  async importAudit(e: RbacAuditEvent): Promise<'inserted' | 'skipped'> {
    const r = await this.q(
      `INSERT INTO rbac_audit (
         audit_id, created_at, correlation_id, actor_object_id, actor_upn, target_object_id,
         event_type, outcome, reason, previous_roles, resulting_roles, assignment_source,
         elevated_acknowledged)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (audit_id) DO NOTHING RETURNING audit_id`,
      [e.id, e.at, e.correlationId, e.actorOid, e.actorUpn, e.targetOid, e.operation, e.outcome,
       e.reason, jsonb(e.previousRoles), jsonb(e.resultingRoles), e.source, e.elevatedAcknowledged]);
    return r.length ? 'inserted' : 'skipped';
  }

  /** Carries the JSON store's bootstrap fact across. Without this the database
   *  would hold the administrator and the bootstrap AUDIT rows but would have
   *  forgotten that bootstrap ever completed, which is a silent loss of state. */
  async importBootstrapState(oid: string): Promise<'inserted' | 'skipped'> {
    const r = await this.q(
      `INSERT INTO rbac_bootstrap_state (singleton, bootstrap_oid, assignment_source)
       VALUES (TRUE,$1,'bootstrap') ON CONFLICT (singleton) DO NOTHING RETURNING bootstrap_oid`, [oid]);
    return r.length ? 'inserted' : 'skipped';
  }

  async bootstrapState(): Promise<{ oid: string; completedAt: string } | null> {
    const r = await this.q<{ bootstrap_oid: string; completed_at: Date }>(
      'SELECT bootstrap_oid, completed_at FROM rbac_bootstrap_state WHERE singleton');
    return r.length ? { oid: r[0].bootstrap_oid, completedAt: iso(r[0].completed_at) } : null;
  }

  async migrationHistory(): Promise<Array<{ migrationId: string; sourceChecksum: string; appliedAt: string }>> {
    const r = await this.q<{ migration_id: string; source_checksum: string; applied_at: Date }>(
      'SELECT migration_id, source_checksum, applied_at FROM rbac_migration ORDER BY applied_at');
    return r.map((x) => ({ migrationId: x.migration_id, sourceChecksum: x.source_checksum, appliedAt: iso(x.applied_at) }));
  }

  async recordMigration(m: {
    migrationId: string; sourceKind: string; sourceChecksum: string;
    assignments: number; auditRows: number;
  }): Promise<'recorded' | 'already_recorded'> {
    const r = await this.q(
      `INSERT INTO rbac_migration (migration_id, source_kind, source_checksum, assignments, audit_rows)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (migration_id) DO NOTHING RETURNING migration_id`,
      [m.migrationId, m.sourceKind, m.sourceChecksum, m.assignments, m.auditRows]);
    return r.length ? 'recorded' : 'already_recorded';
  }

  // ---- test-only surface, matching the reference adapter ------------------
  async auditRowCount(): Promise<number> {
    const r = await this.q<{ n: string }>('SELECT COUNT(*)::text AS n FROM rbac_audit');
    return Number(r[0]?.n ?? 0);
  }
  async allAssignments(): Promise<RoleAssignment[]> {
    const r = await this.q<AssignmentRow>('SELECT * FROM rbac_assignment ORDER BY assigned_at, assignment_id');
    return r.map(mapAssignment);
  }
  async previewCount(): Promise<number> {
    const r = await this.q<{ n: string }>('SELECT COUNT(*)::text AS n FROM rbac_preview_nonce');
    return Number(r[0]?.n ?? 0);
  }
  /** What is ACTUALLY persisted, so a leakage assertion inspects rows rather
   *  than an object that stringifies to {}. */
  async dumpPreviewsForTests(): Promise<Array<Record<string, unknown>>> {
    return this.q<Record<string, unknown>>('SELECT * FROM rbac_preview_nonce');
  }
  /** Destructive; guarded so it can never run against a non-test database. */
  async resetForTests(): Promise<void> {
    if (process.env.WATSON_PG_ALLOW_RESET !== 'yes') throw new Error('reset_not_permitted');
    await this.q('TRUNCATE rbac_assignment, rbac_audit, rbac_preview_nonce, rbac_bootstrap_state, rbac_migration');
  }
}

// ---- helpers --------------------------------------------------------------
// A schema name cannot be a bound parameter, so it is validated rather than
// interpolated on trust. Anything outside this shape is rejected outright.
function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error('invalid_schema_name');
  return name;
}

async function lockAdminSet(c: PoolClient): Promise<void> {
  await c.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_SET_LOCK.toString()]);
}

async function rolesIn(c: PoolClient, oid: string): Promise<WatsonRoleKey[]> {
  const r = await c.query<{ role: WatsonRoleKey }>(
    'SELECT DISTINCT role FROM rbac_assignment WHERE principal_object_id = $1 AND active ORDER BY role', [oid]);
  return r.rows.map((x) => x.role);
}

async function insertAudit(
  c: PoolClient | Pool, e: Omit<RbacAuditEvent, 'id' | 'at'>
): Promise<void> {
  await c.query(
    `INSERT INTO rbac_audit (
       audit_id, correlation_id, actor_object_id, actor_upn, target_object_id,
       event_type, outcome, reason, previous_roles, resulting_roles,
       assignment_source, elevated_acknowledged)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [nextId('aud'), e.correlationId, e.actorOid, e.actorUpn, e.targetOid, e.operation,
     e.outcome, e.reason, jsonb(e.previousRoles), jsonb(e.resultingRoles), e.source,
     e.elevatedAcknowledged]);
}

const jsonb = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));
const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : String(v));

interface AssignmentRow {
  assignment_id: string; principal_object_id: string; role: WatsonRoleKey; active: boolean;
  assignment_source: AssignmentSource; target_display_name: string | null; target_upn: string | null;
  assigned_by_object_id: string; assigned_at: Date; modified_at: Date; modified_by_object_id: string;
  removed_at: Date | null; removed_by_object_id: string | null; version: number;
}
function mapAssignment(r: AssignmentRow): RoleAssignment {
  return {
    assignmentId: r.assignment_id, targetOid: r.principal_object_id, role: r.role, active: r.active,
    source: r.assignment_source, targetDisplayName: r.target_display_name, targetUpn: r.target_upn,
    assignedAt: iso(r.assigned_at), assignedByOid: r.assigned_by_object_id,
    modifiedAt: iso(r.modified_at), modifiedByOid: r.modified_by_object_id,
    removedAt: r.removed_at ? iso(r.removed_at) : null,
    removedByOid: r.removed_by_object_id, version: r.version
  };
}

interface AuditRow {
  audit_id: string; created_at: Date; correlation_id: string; actor_object_id: string;
  actor_upn: string | null; target_object_id: string | null; event_type: string; outcome: string;
  reason: string; previous_roles: unknown; resulting_roles: unknown; assignment_source: string;
  elevated_acknowledged: boolean | null;
}
function mapAudit(r: AuditRow): RbacAuditEvent {
  return {
    id: r.audit_id, at: iso(r.created_at), correlationId: r.correlation_id,
    actorOid: r.actor_object_id, actorUpn: r.actor_upn, targetOid: r.target_object_id,
    operation: r.event_type, outcome: r.outcome, reason: r.reason,
    previousRoles: r.previous_roles, resultingRoles: r.resulting_roles,
    source: r.assignment_source, elevatedAcknowledged: r.elevated_acknowledged
  } as unknown as RbacAuditEvent;
}

interface NonceRow {
  nonce_digest: string; action: 'assign' | 'remove'; actor_object_id: string;
  target_object_id: string; role: WatsonRoleKey; state_version: number;
  elevated_required: boolean; payload: string; created_at: Date; expires_at: Date;
  consumed_at: Date | null;
}
function mapPreview(r: NonceRow): PreviewRecord {
  return {
    digest: r.nonce_digest, operation: r.action, actorOid: r.actor_object_id,
    targetOid: r.target_object_id, role: r.role, stateVersion: r.state_version,
    expiresAt: iso(r.expires_at), elevatedRequired: r.elevated_required, payload: r.payload
  };
}

// Fallback used only when the .sql file is not co-located in a bundled build.
// Kept byte-identical in meaning to postgres-schema.sql.
const EMBEDDED_SCHEMA = `
CREATE TABLE IF NOT EXISTS rbac_schema_version (version INTEGER NOT NULL PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS rbac_assignment (
  assignment_id TEXT NOT NULL PRIMARY KEY, principal_object_id TEXT NOT NULL, role TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE, assignment_source TEXT NOT NULL, target_display_name TEXT,
  target_upn TEXT, assigned_by_object_id TEXT NOT NULL, assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at TIMESTAMPTZ NOT NULL DEFAULT now(), modified_by_object_id TEXT NOT NULL,
  removed_at TIMESTAMPTZ, removed_by_object_id TEXT, elevated_acknowledged BOOLEAN,
  version INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT rbac_assignment_role_known CHECK (role IN ('watson_employee','watson_technician','watson_support_admin','watson_provisioning_admin','watson_security_admin','watson_role_admin')));
CREATE UNIQUE INDEX IF NOT EXISTS rbac_assignment_active_uniq ON rbac_assignment (principal_object_id, role) WHERE active;
CREATE INDEX IF NOT EXISTS rbac_assignment_principal_idx ON rbac_assignment (principal_object_id) WHERE active;
CREATE INDEX IF NOT EXISTS rbac_assignment_admin_idx ON rbac_assignment (role) WHERE active AND role = 'watson_role_admin';
CREATE TABLE IF NOT EXISTS rbac_audit (
  audit_id TEXT NOT NULL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  correlation_id TEXT NOT NULL, actor_object_id TEXT NOT NULL, actor_upn TEXT, target_object_id TEXT,
  event_type TEXT NOT NULL, outcome TEXT NOT NULL, reason TEXT NOT NULL, previous_roles JSONB,
  resulting_roles JSONB, assignment_source TEXT NOT NULL, elevated_acknowledged BOOLEAN,
  CONSTRAINT rbac_audit_outcome_known CHECK (outcome IN ('success','refused','error')));
CREATE INDEX IF NOT EXISTS rbac_audit_target_idx ON rbac_audit (target_object_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rbac_audit_created_idx ON rbac_audit (created_at DESC);
CREATE TABLE IF NOT EXISTS rbac_preview_nonce (
  nonce_digest TEXT NOT NULL PRIMARY KEY, action TEXT NOT NULL, actor_object_id TEXT NOT NULL,
  target_object_id TEXT NOT NULL, role TEXT NOT NULL, state_version INTEGER NOT NULL,
  elevated_required BOOLEAN NOT NULL DEFAULT FALSE, payload TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ,
  CONSTRAINT rbac_nonce_action_known CHECK (action IN ('assign','remove')),
  CONSTRAINT rbac_nonce_digest_shape CHECK (nonce_digest ~ '^[0-9a-f]{64}$'));
CREATE INDEX IF NOT EXISTS rbac_nonce_expiry_idx ON rbac_preview_nonce (expires_at);
CREATE TABLE IF NOT EXISTS rbac_bootstrap_state (
  singleton BOOLEAN NOT NULL PRIMARY KEY DEFAULT TRUE, bootstrap_oid TEXT NOT NULL,
  completed BOOLEAN NOT NULL DEFAULT TRUE, completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  assignment_source TEXT NOT NULL DEFAULT 'bootstrap', CONSTRAINT rbac_bootstrap_singleton CHECK (singleton));
CREATE TABLE IF NOT EXISTS rbac_migration (
  migration_id TEXT NOT NULL PRIMARY KEY, source_kind TEXT NOT NULL, source_checksum TEXT NOT NULL,
  assignments INTEGER NOT NULL, audit_rows INTEGER NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
INSERT INTO rbac_schema_version (version) VALUES (1) ON CONFLICT DO NOTHING;
`;
