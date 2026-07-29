// ============================================================
// Watson — 021A : RBAC authorization service + preview/confirm operations
// ------------------------------------------------------------
// One server-side authorization layer. Every privileged read and mutation
// resolves the actor from TRUSTED Entra claims, reads CURRENT durable role
// state, and fails closed. Nothing here trusts a cookie, header, query
// parameter, request-body actor id, display name or email address.
//
// Mutations are two-step: preview then confirm. The preview issues a single-use
// nonce bound to actor + target + role + the target's role-state version. A
// confirmation that does not match all four is refused, which is what stops
// replay, stale execution, and swapping the target after review.
//
// SERVER-ONLY. No Graph write, no Defender action, no provisioning, no endpoint
// execution is reachable from this module.
// ============================================================
import {
  WATSON_ROLES, WATSON_ROLE_DISCLAIMER, isWatsonRoleKey, capabilitiesFor,
  sodWarnings, requiresElevatedAcknowledgement, canRoleAssign, canRoleRemove,
  type WatsonRoleKey, type Capability
} from './roles';
import { type AssignmentSource, type FailureInjection, type RbacAuditEvent } from './store';
// 021G-2: ALL stateful RBAC access now goes through the async persistence
// contract. The service no longer touches the JSON store directly, so swapping
// in the Postgres adapter (021G-3) requires no change here.
import { rbacStore } from './store-provider';
import { digestNonce, generateNonce, type PreviewRecord } from './persistence';

// ------------------------------------------------------------
// Trusted identity. Produced ONLY from platform-validated Entra claims.
// ------------------------------------------------------------
export interface TrustedIdentity {
  readonly oid: string;              // immutable Entra object id — authoritative
  readonly upn: string | null;       // presentation only
  readonly displayName: string | null; // presentation only
}

// Claims as supplied by the platform (Easy Auth `x-ms-client-principal`,
// already validated before the app sees it). Anything the browser could set is
// deliberately absent from this type.
export interface PlatformClaims {
  oid?: unknown;
  upn?: unknown;
  displayName?: unknown;
}

const OID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Returns null unless the platform supplied a well-formed immutable object id.
// A missing or malformed oid is an authentication failure, never a fallback to
// email or display name.
export function resolveTrustedIdentity(claims: PlatformClaims | null | undefined): TrustedIdentity | null {
  const oid = typeof claims?.oid === 'string' ? claims.oid.trim().toLowerCase() : '';
  if (!oid || !OID_SHAPE.test(oid)) return null;
  return {
    oid,
    upn: typeof claims?.upn === 'string' && claims.upn.trim() ? claims.upn.trim() : null,
    displayName: typeof claims?.displayName === 'string' && claims.displayName.trim() ? claims.displayName.trim() : null
  };
}

export type RefusalReason =
  | 'unauthenticated' | 'not_authorized' | 'unknown_role' | 'invalid_target'
  | 'self_elevation' | 'last_admin_protected' | 'stale_preview' | 'replayed_preview'
  | 'actor_mismatch' | 'target_mismatch' | 'role_mismatch' | 'elevated_ack_required'
  | 'malformed_payload' | 'target_not_found' | 'persistence_failure' | 'audit_failure'
  | 'not_assignable' | 'not_removable' | 'self_assignment_forbidden'
  | 'directory_unavailable'
  | 'store_unavailable';

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; refused: true; reason: RefusalReason };

const refuse = <T,>(reason: RefusalReason): Result<T> => ({ ok: false, refused: true, reason });

function correlation(): string {
  return 'rbac-' + Math.abs(hash(String(Date.now()) + Math.random())).toString(36);
}
function hash(s: string): number {
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h;
}

async function audit(input: {
  actor: TrustedIdentity | null; targetOid: string | null; operation: string;
  outcome: 'success' | 'refused' | 'error'; reason: string;
  previousRoles?: WatsonRoleKey[] | null; resultingRoles?: WatsonRoleKey[] | null;
  source?: AssignmentSource | 'system'; elevatedAcknowledged?: boolean | null;
  correlationId?: string;
}): Promise<void> {
  await rbacStore().appendAudit({
    correlationId: input.correlationId ?? correlation(),
    // Server-resolved actor only. A request body can never influence this.
    actorOid: input.actor?.oid ?? 'anonymous',
    actorUpn: input.actor?.upn ?? null,
    targetOid: input.targetOid,
    operation: input.operation,
    outcome: input.outcome,
    reason: input.reason,
    previousRoles: input.previousRoles ?? null,
    resultingRoles: input.resultingRoles ?? null,
    source: input.source ?? 'system',
    elevatedAcknowledged: input.elevatedAcknowledged ?? null
  });
}

// ------------------------------------------------------------
// Authorization primitives — always read CURRENT durable state, so a revoked
// administrator loses access on the very next request.
// ------------------------------------------------------------
export async function currentRoles(oid: string): Promise<WatsonRoleKey[]> {
  return rbacStore().activeRoles(oid);
}

// Returns a Promise. Every call site MUST await it: a bare Promise is truthy, so
// forgetting the await would grant access unconditionally. The async signature
// is what makes TypeScript reject the unawaited form at every call site.
export async function actorHasCapability(actor: TrustedIdentity, cap: Capability): Promise<boolean> {
  return capabilitiesFor(await currentRoles(actor.oid)).includes(cap);
}

async function requireCapability(
  actor: TrustedIdentity | null, cap: Capability, operation: string, targetOid: string | null
): Promise<Result<TrustedIdentity>> {
  // Every privileged operation passes through here, so this is the one place
  // bootstrap needs to be attempted.
  await ensureBootstrap();
  if (!actor) {
    await audit({ actor: null, targetOid, operation, outcome: 'refused', reason: 'unauthenticated' });
    return refuse('unauthenticated');
  }
  // A store failure must NOT read as "not authorized" and must never read as
  // authorized: it propagates as an explicit unavailable result.
  let allowed: boolean;
  try {
    allowed = await actorHasCapability(actor, cap);
  } catch {
    return refuse('store_unavailable');
  }
  if (!allowed) {
    await audit({ actor, targetOid, operation, outcome: 'refused', reason: 'not_authorized' });
    return refuse('not_authorized');
  }
  return { ok: true, data: actor };
}

// ------------------------------------------------------------
// Process-wide RBAC runtime state.
//
// 021C-1A: Next.js compiles this module into more than one module graph (the
// react-server layer that renders the page, the route-handler layer that serves
// /api/it-agent/rbac/*), and dev hot reload re-evaluates it again. Module-level
// `let`/`Map` state therefore is NOT one instance — bootstrap could run against
// one copy while the page read another, and previews issued by one copy were
// invisible to the other. The durable store is already globalThis-backed, so
// anchoring the runtime state the same way makes bootstrap, authorization, page
// rendering and RBAC routes provably share one state. Production persistence is
// untouched: this changes only where the in-process guard lives.
// ------------------------------------------------------------
export type BootstrapOutcome =
  | 'not_attempted'
  | 'bootstrap_not_configured'
  | 'persistent_admin_exists'
  | 'bootstrap_role_admin_created'
  | 'bootstrap_persistence_failure'
  | 'bootstrap_error';

interface RbacGlobals {
  bootstrapAttempted: boolean;
  bootstrapInFlight?: Promise<void>;
  bootstrapOutcome: BootstrapOutcome;
}

function rbacGlobals(): RbacGlobals {
  const g = globalThis as unknown as { __watsonRbacRuntime?: RbacGlobals };
  if (!g.__watsonRbacRuntime) {
    g.__watsonRbacRuntime = { bootstrapAttempted: false, bootstrapOutcome: 'not_attempted' };
  }
  return g.__watsonRbacRuntime;
}

// ------------------------------------------------------------
// Bootstrap — explicit, configuration-backed, immutable-id only.
// ------------------------------------------------------------
export interface BootstrapPosture {
  configured: boolean;
  // Presence only; the value is never surfaced.
  hasImmutableOid: boolean;
  persistentAdminExists: boolean;
  // True only when a bootstrap would actually do something.
  bootstrapWouldApply: boolean;
}

export async function bootstrapPosture(env: NodeJS.ProcessEnv = process.env): Promise<BootstrapPosture> {
  const oid = env.WATSON_RBAC_BOOTSTRAP_OID?.trim() ?? '';
  const configured = Boolean(oid) && OID_SHAPE.test(oid);
  const persistentAdminExists = (await rbacStore().countActiveRoleAdmins()) > 0;
  return {
    configured,
    hasImmutableOid: configured,
    persistentAdminExists,
    bootstrapWouldApply: configured && !persistentAdminExists
  };
}

// Bootstrap runs from SERVER CONFIGURATION ONLY. There is no request parameter,
// header, cookie or body field that can reach it, and it is a no-op once any
// persistent role administrator exists.
export async function runBootstrap(env: NodeJS.ProcessEnv = process.env): Promise<Result<{ applied: boolean; reason: string }>> {
  const raw = env.WATSON_RBAC_BOOTSTRAP_OID?.trim() ?? '';
  if (!raw || !OID_SHAPE.test(raw)) {
    // Covers both "not set" and "set but not a well-formed immutable object id".
    // A malformed value is never normalised into something usable.
    await audit({ actor: null, targetOid: null, operation: 'bootstrap', outcome: 'refused', reason: 'bootstrap_not_configured', source: 'bootstrap' });
    return { ok: true, data: { applied: false, reason: 'bootstrap_not_configured' } };
  }
  const oid = raw.toLowerCase();
  // Count-and-create happen inside ONE adapter call, so concurrent
  // initialization cannot create two bootstrap records.
  const r = await rbacStore().tryBootstrap(oid, correlation());
  if (!r.ok) return refuse('persistence_failure');
  return { ok: true, data: { applied: r.data.applied, reason: r.data.reason } };
}

// Idempotent bootstrap guard, invoked at the top of every RBAC entry point.
//
// 021C-1 found runBootstrap() implemented and tested but wired into NO request
// path: on a fresh deployment nobody would ever become the first role
// administrator and the whole feature would be unusable. Calling it here is
// safe because it is a no-op once any active role administrator exists, it
// reads configuration only, and no request input can reach it.
// 021C-1A additionally makes the guard PROCESS-WIDE and records WHY bootstrap
// did or did not apply. Previously the outcome existed only as a row in the RBAC
// audit store and the catch swallowed everything, so an operator staring at
// "You do not have permission to administer Watson roles" had no way to learn
// that bootstrap had deliberately no-opped because the store already contained an
// active role administrator. The recorded value is a fixed category from a closed
// vocabulary — never an object id, claim, cookie, token or secret.
export async function ensureBootstrap(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const g = rbacGlobals();
  // A single in-flight promise is shared, so concurrent first requests await the
  // SAME initialization rather than each starting their own.
  if (g.bootstrapInFlight) return g.bootstrapInFlight;
  if (g.bootstrapAttempted) return;
  g.bootstrapInFlight = (async () => {
    try {
      const r = await runBootstrap(env);
      g.bootstrapOutcome = r.ok ? (r.data.reason as BootstrapOutcome) : 'bootstrap_persistence_failure';
    } catch {
      // Bootstrap must never break a request — but it must not vanish either.
      g.bootstrapOutcome = 'bootstrap_error';
    }
    g.bootstrapAttempted = true;
    g.bootstrapInFlight = undefined;
    // Safe, category-only, emitted once per process.
    console.info(`[watson][rbac] bootstrap outcome: ${g.bootstrapOutcome}`);
  })();
  return g.bootstrapInFlight;
}

// Diagnostic accessor. Reports the category only; the configured object id is
// never surfaced through it.
export function lastBootstrapOutcome(): BootstrapOutcome {
  return rbacGlobals().bootstrapOutcome;
}

export function __resetBootstrapGuardForTests(): void {
  const g = rbacGlobals();
  g.bootstrapAttempted = false;
  g.bootstrapInFlight = undefined;
  g.bootstrapOutcome = 'not_attempted';
}

// ------------------------------------------------------------
// Preview / confirm
// ------------------------------------------------------------
export interface RolePreview {
  nonce: string;
  operation: 'assign' | 'remove';
  actorOid: string;
  targetOid: string;
  targetDisplayName: string | null;
  role: WatsonRoleKey;
  roleDisplayName: string;
  roleStatus: 'functional' | 'reserved';
  risk: string;
  currentRoles: WatsonRoleKey[];
  resultingRoles: WatsonRoleKey[];
  capabilitiesGained: Capability[];
  capabilitiesLost: Capability[];
  sodWarnings: string[];
  lastAdminImplication: string | null;
  requiresElevatedAcknowledgement: boolean;
  stateVersion: number;
  disclaimer: string;
}

// 021G-2: previews now live in the persistence adapter, keyed by a SHA-256
// DIGEST of the nonce. The raw nonce is returned to the caller once and never
// stored, and the binding + single-use check + consumption happen in ONE atomic
// adapter call — the caller cannot read-then-consume-then-mutate as steps.
const PREVIEW_TTL_MS = 10 * 60 * 1000;

export function __resetPreviewsForTests(): void {
  const store = rbacStore() as unknown as { __resetPreviewsForTests?: () => void; reset?: () => void };
  store.__resetPreviewsForTests?.();
}

function validTarget(oid: unknown): string | null {
  if (typeof oid !== 'string') return null;
  const v = oid.trim().toLowerCase();
  return OID_SHAPE.test(v) ? v : null;
}

export async function previewAssignment(
  actor: TrustedIdentity | null, targetOidRaw: unknown, roleRaw: unknown,
  targetDisplayName: string | null = null, targetUpn: string | null = null
): Promise<Result<RolePreview>> {
  const gate = await requireCapability(actor, 'rbac.assign', 'assign_preview', validTarget(targetOidRaw));
  if (!gate.ok) return gate as Result<RolePreview>;
  const a = gate.data;

  if (!isWatsonRoleKey(roleRaw)) {
    await audit({ actor: a, targetOid: validTarget(targetOidRaw), operation: 'assign_preview', outcome: 'refused', reason: 'unknown_role' });
    return refuse('unknown_role');
  }
  const target = validTarget(targetOidRaw);
  if (!target) {
    await audit({ actor: a, targetOid: null, operation: 'assign_preview', outcome: 'refused', reason: 'invalid_target' });
    return refuse('invalid_target');
  }
  // Self-elevation is refused structurally, before any policy nuance.
  if (target === a.oid && !WATSON_ROLES[roleRaw].selfAssignable) {
    await audit({ actor: a, targetOid: target, operation: 'assign_preview', outcome: 'refused', reason: 'self_elevation' });
    return refuse('self_elevation');
  }
  if (!canRoleAssign(await currentRoles(a.oid), roleRaw)) {
    await audit({ actor: a, targetOid: target, operation: 'assign_preview', outcome: 'refused', reason: 'not_assignable' });
    return refuse('not_assignable');
  }

  const before = await currentRoles(target);
  const after = [...new Set([...before, roleRaw])].sort() as WatsonRoleKey[];
  const preview = await buildPreview('assign', a, target, targetDisplayName, roleRaw, before, after, null);
  await persistPreview(preview);
  await audit({ actor: a, targetOid: target, operation: 'assign_preview', outcome: 'success', reason: 'preview_issued', previousRoles: before, resultingRoles: after, correlationId: preview.nonce });
  return { ok: true, data: preview };
}

export async function previewRemoval(
  actor: TrustedIdentity | null, targetOidRaw: unknown, roleRaw: unknown,
  targetDisplayName: string | null = null
): Promise<Result<RolePreview>> {
  const gate = await requireCapability(actor, 'rbac.remove', 'remove_preview', validTarget(targetOidRaw));
  if (!gate.ok) return gate as Result<RolePreview>;
  const a = gate.data;

  if (!isWatsonRoleKey(roleRaw)) {
    await audit({ actor: a, targetOid: validTarget(targetOidRaw), operation: 'remove_preview', outcome: 'refused', reason: 'unknown_role' });
    return refuse('unknown_role');
  }
  const target = validTarget(targetOidRaw);
  if (!target) {
    await audit({ actor: a, targetOid: null, operation: 'remove_preview', outcome: 'refused', reason: 'invalid_target' });
    return refuse('invalid_target');
  }
  if (!canRoleRemove(await currentRoles(a.oid), roleRaw)) {
    await audit({ actor: a, targetOid: target, operation: 'remove_preview', outcome: 'refused', reason: 'not_removable' });
    return refuse('not_removable');
  }

  const before = await currentRoles(target);
  const after = before.filter((r) => r !== roleRaw);
  // Last-admin implication is computed at preview AND re-checked at confirm.
  let lastAdmin: string | null = null;
  if (roleRaw === 'watson_role_admin' && before.includes('watson_role_admin')) {
    if ((await rbacStore().countActiveRoleAdmins()) <= 1) lastAdmin = 'This is the final Watson role administrator. Removal will be refused.';
    else if (target === a.oid) lastAdmin = 'You are removing your own role-administration access. You will lose it on your next request.';
  }
  const preview = await buildPreview('remove', a, target, targetDisplayName, roleRaw, before, after, lastAdmin);
  await persistPreview(preview);
  await audit({ actor: a, targetOid: target, operation: 'remove_preview', outcome: 'success', reason: 'preview_issued', previousRoles: before, resultingRoles: after, correlationId: preview.nonce });
  return { ok: true, data: preview };
}

async function buildPreview(
  operation: 'assign' | 'remove', actor: TrustedIdentity, target: string,
  targetDisplayName: string | null, role: WatsonRoleKey,
  before: WatsonRoleKey[], after: WatsonRoleKey[], lastAdmin: string | null
): Promise<RolePreview> {
  const capsBefore = capabilitiesFor(before);
  const capsAfter = capabilitiesFor(after);
  return {
    // 256-bit CSPRNG. Returned to the caller once; only its digest is stored.
    nonce: await generateNonce(),
    operation,
    actorOid: actor.oid,
    targetOid: target,
    targetDisplayName,
    role,
    roleDisplayName: WATSON_ROLES[role].displayName,
    roleStatus: WATSON_ROLES[role].status,
    risk: WATSON_ROLES[role].risk,
    currentRoles: before,
    resultingRoles: after,
    capabilitiesGained: capsAfter.filter((c) => !capsBefore.includes(c)),
    capabilitiesLost: capsBefore.filter((c) => !capsAfter.includes(c)),
    sodWarnings: sodWarnings(after),
    lastAdminImplication: lastAdmin,
    requiresElevatedAcknowledgement: requiresElevatedAcknowledgement(role, after),
    stateVersion: await rbacStore().roleStateVersion(target),
    disclaimer: WATSON_ROLE_DISCLAIMER
  };
}

export interface ConfirmInput {
  nonce: unknown;
  targetOid: unknown;
  role: unknown;
  elevatedAcknowledged?: unknown;
}

// Persist a preview as a digest record. The raw nonce never reaches the store.
async function persistPreview(p: RolePreview): Promise<void> {
  const record: PreviewRecord = {
    digest: await digestNonce(p.nonce),
    operation: p.operation,
    actorOid: p.actorOid,
    targetOid: p.targetOid,
    role: p.role,
    stateVersion: p.stateVersion,
    expiresAt: new Date(Date.now() + PREVIEW_TTL_MS).toISOString(),
    elevatedRequired: p.requiresElevatedAcknowledgement,
    payload: JSON.stringify({ targetDisplayName: p.targetDisplayName, currentRoles: p.currentRoles, resultingRoles: p.resultingRoles })
  };
  await rbacStore().putPreview(record);
}

// Atomically validate the binding AND consume the nonce. One adapter call, so a
// caller cannot read the nonce, act, and mark it consumed as separate steps.
async function takePreview(
  actor: TrustedIdentity, input: ConfirmInput, expected: 'assign' | 'remove'
): Promise<Result<PreviewRecord>> {
  const raw = typeof input.nonce === 'string' ? input.nonce : '';
  if (!raw) return refuse('stale_preview');
  const target = validTarget(input.targetOid);
  const r = await rbacStore().consumePreview(
    await digestNonce(raw),
    { operation: expected, actorOid: actor.oid, targetOid: target ?? '', role: input.role },
    Date.now()
  );
  if (!r.ok) return refuse(r.reason);
  return { ok: true, data: r.record };
}

export async function confirmAssignment(
  actor: TrustedIdentity | null, input: ConfirmInput, inject: FailureInjection = {}
): Promise<Result<{ applied: boolean; roles: WatsonRoleKey[]; idempotent: boolean }>> {
  const gate = await requireCapability(actor, 'rbac.assign', 'assign_confirm', validTarget(input.targetOid));
  if (!gate.ok) return gate as never;
  const a = gate.data;

  // Binding check AND single-use consumption in ONE atomic adapter call.
  const taken = await takePreview(a, input, 'assign');
  if (!taken.ok) {
    await audit({ actor: a, targetOid: validTarget(input.targetOid), operation: 'assign_confirm', outcome: 'refused', reason: taken.reason });
    return taken as never;
  }
  const p = taken.data;
  const payload = parsePayload(p.payload);

  if (p.elevatedRequired && input.elevatedAcknowledged !== true) {
    await audit({ actor: a, targetOid: p.targetOid, operation: 'assign_confirm', outcome: 'refused', reason: 'elevated_ack_required', elevatedAcknowledged: false });
    return refuse('elevated_ack_required');
  }

  // Assignment AND its audit row commit together, or neither. Idempotency is
  // decided inside the adapter, not by a caller read-then-write.
  const r = await rbacStore().grantRole({
    targetOid: p.targetOid, targetDisplayName: payload.targetDisplayName, targetUpn: null,
    role: p.role, source: 'administrator', actorOid: a.oid, actorUpn: a.upn,
    correlationId: p.digest.slice(0, 12), elevatedAcknowledged: input.elevatedAcknowledged === true,
    previousRoles: payload.currentRoles, resultingRoles: payload.resultingRoles, inject
  });
  if (!r.ok) {
    await audit({ actor: a, targetOid: p.targetOid, operation: 'assign_confirm', outcome: 'error', reason: r.reason });
    return refuse(r.reason === 'audit_failure' ? 'audit_failure' : r.reason === 'store_unavailable' ? 'store_unavailable' : 'persistence_failure');
  }
  return { ok: true, data: { applied: r.data.applied, roles: r.data.roles, idempotent: r.data.idempotent } };
}

export async function confirmRemoval(
  actor: TrustedIdentity | null, input: ConfirmInput, inject: FailureInjection = {}
): Promise<Result<{ applied: boolean; roles: WatsonRoleKey[]; idempotent: boolean }>> {
  const gate = await requireCapability(actor, 'rbac.remove', 'remove_confirm', validTarget(input.targetOid));
  if (!gate.ok) return gate as never;
  const a = gate.data;

  const taken = await takePreview(a, input, 'remove');
  if (!taken.ok) {
    await audit({ actor: a, targetOid: validTarget(input.targetOid), operation: 'remove_confirm', outcome: 'refused', reason: taken.reason });
    return taken as never;
  }
  const p = taken.data;
  const payload = parsePayload(p.payload);

  // Self-removal while another admin exists still needs explicit acknowledgement.
  if (p.role === 'watson_role_admin' && p.targetOid === a.oid && input.elevatedAcknowledged !== true) {
    await audit({ actor: a, targetOid: p.targetOid, operation: 'remove_confirm', outcome: 'refused', reason: 'elevated_ack_required', elevatedAcknowledged: false });
    return refuse('elevated_ack_required');
  }

  // FINAL-ADMINISTRATOR PROTECTION is enforced INSIDE revokeRole, in the same
  // atomic boundary as the removal — never as a caller-side count-then-delete.
  const r = await rbacStore().revokeRole({
    targetOid: p.targetOid, role: p.role, actorOid: a.oid, actorUpn: a.upn,
    correlationId: p.digest.slice(0, 12), elevatedAcknowledged: input.elevatedAcknowledged === true,
    previousRoles: payload.currentRoles, resultingRoles: payload.resultingRoles, inject
  });
  if (!r.ok) {
    if (r.reason === 'last_admin_protected') return refuse('last_admin_protected');
    await audit({ actor: a, targetOid: p.targetOid, operation: 'remove_confirm', outcome: 'error', reason: r.reason });
    return refuse(r.reason === 'audit_failure' ? 'audit_failure' : r.reason === 'store_unavailable' ? 'store_unavailable' : 'persistence_failure');
  }
  return { ok: true, data: { applied: r.data.applied, roles: r.data.roles, idempotent: r.data.idempotent } };
}

// The preview payload carries presentation state only; it is never authoritative.
function parsePayload(raw: string): { targetDisplayName: string | null; currentRoles: WatsonRoleKey[]; resultingRoles: WatsonRoleKey[] } {
  try {
    const v = JSON.parse(raw) as { targetDisplayName?: string | null; currentRoles?: WatsonRoleKey[]; resultingRoles?: WatsonRoleKey[] };
    return {
      targetDisplayName: v.targetDisplayName ?? null,
      currentRoles: Array.isArray(v.currentRoles) ? v.currentRoles : [],
      resultingRoles: Array.isArray(v.resultingRoles) ? v.resultingRoles : []
    };
  } catch {
    return { targetDisplayName: null, currentRoles: [], resultingRoles: [] };
  }
}

// ------------------------------------------------------------
// Authorized reads
// ------------------------------------------------------------
export async function readRegistry(actor: TrustedIdentity | null): Promise<Result<typeof WATSON_ROLES>> {
  const gate = await requireCapability(actor, 'rbac.registry.read', 'registry_read', null);
  if (!gate.ok) return gate as Result<typeof WATSON_ROLES>;
  return { ok: true, data: WATSON_ROLES };
}

export async function readEmployeeRoles(
  actor: TrustedIdentity | null, targetOidRaw: unknown
): Promise<Result<{ targetOid: string; roles: WatsonRoleKey[]; capabilities: Capability[] }>> {
  const target = validTarget(targetOidRaw);
  const gate = await requireCapability(actor, 'rbac.employee.read', 'employee_role_read', target);
  if (!gate.ok) return gate as never;
  if (!target) {
    await audit({ actor: gate.data, targetOid: null, operation: 'employee_role_read', outcome: 'refused', reason: 'invalid_target' });
    return refuse('invalid_target');
  }
  const roles = await currentRoles(target);
  return { ok: true, data: { targetOid: target, roles, capabilities: capabilitiesFor(roles) } };
}

export async function readAuditHistory(
  actor: TrustedIdentity | null, targetOid?: string, limit = 100
): Promise<Result<RbacAuditEvent[]>> {
  const gate = await requireCapability(actor, 'rbac.audit.read', 'audit_read', targetOid ?? null);
  if (!gate.ok) return gate as Result<RbacAuditEvent[]>;
  return { ok: true, data: await rbacStore().listAudit({ targetOid, limit }) };
}

// ------------------------------------------------------------
// Employee directory search abstraction.
//
// No Graph permission is expanded. When live reads are disabled this serves a
// clearly-labelled staged directory. Directory text is treated as untrusted
// data: it is length-capped and stripped of control characters so a display
// name cannot carry an injection payload into a later prompt or log.
// ------------------------------------------------------------
// 021E: the DTO the browser receives. `oid` remains the ONLY durable identity
// key — displayName, upn and mail are presentation and are never authoritative.
// The eligibility fields describe how the directory policy classified the row so
// the UI can present risk honestly; they are NOT an authorization control.
export interface DirectoryEntry {
  oid: string;
  displayName: string;
  upn: string;
  mail?: string | null;
  accountEnabled?: boolean | null;
  userType?: string | null;
  employeeEligibility?: 'eligible' | 'not_eligible' | 'ambiguous';
  eligibilityReasonCode?: string;
  selectionAllowed?: boolean;
}

export type DirectoryProvenance = 'mock_staged_directory' | 'graph_live';

// 021C-2: provenance travels WITH the data. Staging found that `source` was
// derived from IT_AGENT_GRAPH_LIVE_READONLY while the entries still came from
// whatever directory the caller passed — so turning the flag on would have made
// the response claim `graph_live` while serving hardcoded mock fixtures. An
// administrator deciding who to grant access to must never be told mock rows are
// live tenant data. A directory now declares what it is; the flag only reports
// the state of the gate.
export interface DirectorySource {
  readonly provenance: DirectoryProvenance;
  readonly entries: readonly DirectoryEntry[];
}

export interface SearchResult {
  source: DirectoryProvenance;
  liveReadsEnabled: boolean;
  // True when the live-read gate is on but the data served is NOT live. Makes a
  // misconfiguration visible instead of silently mislabelled.
  provenanceMismatch: boolean;
  results: DirectoryEntry[];
  truncated: boolean;
}

const MIN_QUERY = 3;
const MAX_RESULTS = 25;

export function sanitizeDirectoryText(v: unknown): string {
  return String(v ?? '')
    .replace(/[ -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export async function searchEmployees(
  actor: TrustedIdentity | null, queryRaw: unknown,
  directory: readonly DirectoryEntry[] | DirectorySource, env: NodeJS.ProcessEnv = process.env
): Promise<Result<SearchResult>> {
  const gate = await requireCapability(actor, 'rbac.employee.read', 'employee_search', null);
  if (!gate.ok) return gate as never;

  const q = sanitizeDirectoryText(queryRaw).toLowerCase();
  // A minimum length prevents using search as a directory dump.
  if (q.length < MIN_QUERY) return refuse('malformed_payload');

  // A bare array carries no provenance claim, so it can only ever be reported as
  // staged mock data. Claiming `graph_live` requires a directory that explicitly
  // declares itself live — the environment flag alone can never promote it.
  const entries: readonly DirectoryEntry[] = Array.isArray(directory)
    ? directory
    : (directory as DirectorySource).entries;
  const provenance: DirectoryProvenance = Array.isArray(directory)
    ? 'mock_staged_directory'
    : (directory as DirectorySource).provenance;

  const liveReadsEnabled = (env.IT_AGENT_GRAPH_LIVE_READONLY ?? 'false').toLowerCase() === 'true';
  const matches = entries
    .filter((e) => `${e.displayName} ${e.upn}`.toLowerCase().includes(q))
    .map((e) => ({
      oid: e.oid,
      displayName: sanitizeDirectoryText(e.displayName),
      upn: sanitizeDirectoryText(e.upn),
      // A row that already carries an eligibility decision (Graph) keeps it; a
      // staged fixture is selectable so local flows behave as before.
      mail: e.mail ?? null,
      accountEnabled: e.accountEnabled ?? true,
      userType: e.userType ?? 'Member',
      employeeEligibility: e.employeeEligibility ?? 'eligible',
      eligibilityReasonCode: e.eligibilityReasonCode ?? 'eligible_employee',
      selectionAllowed: e.selectionAllowed ?? true
    }));

  return {
    ok: true,
    data: {
      // Reported from the DATA's own provenance, never from the gate flag.
      source: provenance,
      liveReadsEnabled,
      provenanceMismatch: liveReadsEnabled && provenance !== 'graph_live',
      results: matches.slice(0, MAX_RESULTS),
      truncated: matches.length > MAX_RESULTS
    }
  };
}

// ------------------------------------------------------------
// Reserved-role inertness. Asserted by tests: holding a reserved role must
// never authorize a real operation.
// ------------------------------------------------------------
export const RESERVED_OPERATIONS = [
  'create_user', 'create_mailbox', 'assign_licence', 'modify_group',
  'modify_defender', 'purge_mail', 'block_domain', 'enable_graph_write',
  'endpoint_execute', 'remote_control'
] as const;

export function canPerformReservedOperation(): false {
  // There is no code path that returns true. Reserved roles grant approval
  // intent for a future build, never execution today.
  return false;
}
