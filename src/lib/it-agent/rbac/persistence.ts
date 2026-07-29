// ============================================================
// Watson — 021G : RBAC persistence contract (SERVER-ONLY)
// ------------------------------------------------------------
// The single seam between the RBAC security core and whatever actually stores
// role state. It exists to remove the last structural production blocker: the
// JSON store is single-instance and preview nonces live in a process-local Map,
// so a second App Service worker would silently disagree with the first.
//
// The contract is deliberately COARSE. Every operation that must be atomic is
// ONE method, not a sequence the caller could interleave:
//
//   * grantRole      — assignment AND its audit row, or neither.
//   * revokeRole     — final-administrator protection is evaluated INSIDE the
//                      same atomic boundary as the removal, so two concurrent
//                      removals can never take the administrator count to zero.
//                      An application-side count-then-delete is exactly the race
//                      this design exists to make impossible.
//   * consumePreview — binding checks and single-use consumption happen together,
//                      so two concurrent confirmations of one nonce produce
//                      exactly one mutation.
//   * tryBootstrap   — idempotent; a no-op once any active administrator exists.
//
// A caller cannot express an unsafe sequence, because the unsafe sequence is not
// in the interface.
//
// NOTHING here returns a connection string, credential, driver error or raw
// database message. Failures surface as safe categories.
// ============================================================
import type { WatsonRoleKey } from './roles';
import type { RoleAssignment, RbacAuditEvent, AssignmentSource } from './store';

export type RbacStoreKind = 'memory' | 'postgres' | 'json_legacy';

// Safe, stable failure categories. A driver message never reaches a caller.
export type PersistenceFailure =
  | 'store_unavailable'
  | 'persistence_failure'
  | 'audit_failure'
  | 'last_admin_protected'
  | 'conflict';

export type PersistenceResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: PersistenceFailure };

// ------------------------------------------------------------
// Preview nonces.
//
// The RAW nonce is never persisted. Only a digest is stored, so a database read
// (backup, log, support dump, compromised replica) cannot yield a usable
// confirmation token. The binding fields are stored alongside so a substituted
// actor, target, role or action is rejected at consumption time rather than by
// the caller comparing values it could get wrong.
// ------------------------------------------------------------
export interface PreviewRecord {
  digest: string;                 // SHA-256 of the raw nonce; never the nonce
  operation: 'assign' | 'remove';
  actorOid: string;
  targetOid: string;
  role: WatsonRoleKey;
  stateVersion: number;
  expiresAt: string;              // ISO
  elevatedRequired: boolean;
  // Presentation payload the UI needs when re-rendering; never authoritative.
  payload: string;
}

// Why a consumption attempt failed. These map onto the existing refusal reasons
// so the HTTP surface is unchanged.
export type PreviewConsumeFailure =
  | 'stale_preview'
  | 'replayed_preview'
  | 'actor_mismatch'
  | 'target_mismatch'
  | 'role_mismatch';

export interface PreviewBinding {
  operation: 'assign' | 'remove';
  actorOid: string;
  targetOid: string;
  role: unknown;
  // The CURRENT role-state version, computed inside the same atomic boundary.
  expectedStateVersion?: number;
}

export type PreviewConsume =
  | { ok: true; record: PreviewRecord }
  | { ok: false; reason: PreviewConsumeFailure };

// Test-only fault injection, carried through the contract so the atomicity
// assertions exercise the REAL commit path rather than a mock of it.
export interface AdapterFailureInjection {
  failAssignmentWrite?: boolean;
  failAuditWrite?: boolean;
}

export interface GrantInput {
  targetOid: string;
  targetDisplayName: string | null;
  targetUpn: string | null;
  role: WatsonRoleKey;
  source: AssignmentSource;
  actorOid: string;
  actorUpn: string | null;
  correlationId: string;
  elevatedAcknowledged: boolean | null;
  previousRoles: WatsonRoleKey[];
  resultingRoles: WatsonRoleKey[];
  inject?: AdapterFailureInjection;
}

export interface RevokeInput {
  targetOid: string;
  role: WatsonRoleKey;
  actorOid: string;
  actorUpn: string | null;
  correlationId: string;
  elevatedAcknowledged: boolean | null;
  previousRoles: WatsonRoleKey[];
  resultingRoles: WatsonRoleKey[];
  inject?: AdapterFailureInjection;
}

export interface MutationOutcome {
  applied: boolean;      // false when the operation was a no-op (idempotent)
  idempotent: boolean;
  roles: WatsonRoleKey[];
}

export interface BootstrapOutcome {
  applied: boolean;
  reason: 'bootstrap_role_admin_created' | 'persistent_admin_exists' | 'bootstrap_not_configured';
}

// ------------------------------------------------------------
// The adapter contract.
// ------------------------------------------------------------
export interface RbacStoreAdapter {
  readonly kind: RbacStoreKind;

  // Liveness. A configured-but-unreachable store must fail the service closed
  // rather than fall back to process-local or legacy state.
  ping(): Promise<boolean>;

  // ---- reads (always CURRENT durable state) ----
  activeRoles(targetOid: string): Promise<WatsonRoleKey[]>;
  activeAssignments(targetOid: string): Promise<RoleAssignment[]>;
  countActiveRoleAdmins(): Promise<number>;
  roleStateVersion(targetOid: string): Promise<number>;
  listAudit(filter: { targetOid?: string; limit?: number }): Promise<RbacAuditEvent[]>;

  // ---- atomic mutations (assignment + audit together, or neither) ----
  grantRole(input: GrantInput): Promise<PersistenceResult<MutationOutcome>>;
  // Final-administrator protection is enforced INSIDE this call.
  revokeRole(input: RevokeInput): Promise<PersistenceResult<MutationOutcome>>;

  // ---- audit-only append, for refusals where nothing is mutated ----
  appendAudit(event: Omit<RbacAuditEvent, 'id' | 'at'>): Promise<PersistenceResult<void>>;

  // ---- preview nonces, shared across workers ----
  putPreview(record: PreviewRecord): Promise<PersistenceResult<void>>;
  // Atomic: validates binding + expiry + single-use and consumes in one step.
  consumePreview(digest: string, binding: PreviewBinding, nowMs: number): Promise<PreviewConsume>;
  // Housekeeping; expired rows must not accumulate forever.
  purgeExpiredPreviews(nowMs: number): Promise<number>;

  // ---- bootstrap ----
  tryBootstrap(oid: string, correlationId: string): Promise<PersistenceResult<BootstrapOutcome>>;
}

// Hash a raw nonce for storage/lookup. Node's crypto is used directly so the
// digest is identical across adapters and across workers.
export async function digestNonce(raw: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

// Generate a cryptographically unguessable nonce. 256 bits of CSPRNG output.
// The raw value is returned to the caller ONCE and never stored.
export async function generateNonce(): Promise<string> {
  const { randomBytes } = await import('node:crypto');
  return 'nonce-' + randomBytes(32).toString('base64url');
}
