// ============================================================
// Watson — 021A : RBAC persistence + append-only audit (SERVER-ONLY)
// ------------------------------------------------------------
// Assignments are keyed by an IMMUTABLE Entra object id. Display name and
// email are carried for presentation only and are never authoritative — a
// renamed or re-addressed employee keeps their access, and an attacker cannot
// acquire someone else's access by matching their display name.
//
// Removal is a deactivation, never a delete: the history is the audit trail.
//
// Every mutation commits the assignment change and its audit event TOGETHER.
// `commitAtomically` stages both and rolls the store back if either fails, so
// there is never an assignment without an audit record or an audit success
// without an assignment.
// ============================================================
import { db, save, uuid, nowIso } from '../../store/db';
import type { WatsonRoleKey } from './roles';

export type AssignmentSource = 'bootstrap' | 'administrator' | 'migration';

export interface RoleAssignment {
  assignmentId: string;
  // Authoritative key — Entra object id. NEVER an email or display name.
  targetOid: string;
  // Presentation only.
  targetDisplayName: string | null;
  targetUpn: string | null;
  role: WatsonRoleKey;
  active: boolean;
  source: AssignmentSource;
  assignedAt: string;
  assignedByOid: string;
  modifiedAt: string;
  modifiedByOid: string;
  removedAt: string | null;
  removedByOid: string | null;
  // Optimistic-concurrency token for THIS assignment row.
  version: number;
}

export type RbacAuditOutcome = 'success' | 'refused' | 'error';

export interface RbacAuditEvent {
  id: string;
  at: string;
  correlationId: string;
  // Always the server-resolved actor. A request body can never set this.
  actorOid: string;
  actorUpn: string | null;
  targetOid: string | null;
  operation: string;
  outcome: RbacAuditOutcome;
  // Safe category, never a raw error or payload echo.
  reason: string;
  previousRoles: WatsonRoleKey[] | null;
  resultingRoles: WatsonRoleKey[] | null;
  source: AssignmentSource | 'system';
  elevatedAcknowledged: boolean | null;
}

interface RbacShape {
  rbacAssignments: RoleAssignment[];
  rbacAudit: RbacAuditEvent[];
}

// The shared db() object is untyped for our slice; attach lazily so no
// migration step is required and existing suites are unaffected.
function store(): RbacShape {
  const d = db() as unknown as RbacShape;
  if (!Array.isArray(d.rbacAssignments)) d.rbacAssignments = [];
  if (!Array.isArray(d.rbacAudit)) d.rbacAudit = [];
  return d;
}

export function __resetRbacForTests(): void {
  const d = store();
  d.rbacAssignments.length = 0;
  d.rbacAudit.length = 0;
}

// ------------------------------------------------------------
// Reads
// ------------------------------------------------------------
export function activeAssignments(targetOid: string): RoleAssignment[] {
  return store().rbacAssignments.filter((a) => a.targetOid === targetOid && a.active);
}

export function activeRoles(targetOid: string): WatsonRoleKey[] {
  return [...new Set(activeAssignments(targetOid).map((a) => a.role))].sort() as WatsonRoleKey[];
}

export function allAssignments(): readonly RoleAssignment[] {
  return store().rbacAssignments;
}

export function findActive(targetOid: string, role: WatsonRoleKey): RoleAssignment | null {
  return store().rbacAssignments.find((a) => a.targetOid === targetOid && a.role === role && a.active) ?? null;
}

// Everyone currently holding a role — used for last-admin protection.
export function activeHoldersOf(role: WatsonRoleKey): string[] {
  return [...new Set(store().rbacAssignments.filter((a) => a.active && a.role === role).map((a) => a.targetOid))];
}

export function countActiveRoleAdmins(): number {
  return activeHoldersOf('watson_role_admin').length;
}

// A monotonically increasing token over the TARGET's whole role state. A
// preview embeds this; if anything about that person's roles changed in the
// meantime the confirmation is stale and refused.
export function roleStateVersion(targetOid: string): number {
  return store().rbacAssignments
    .filter((a) => a.targetOid === targetOid)
    .reduce((n, a) => n + a.version, 0);
}

export function listAudit(filter: { targetOid?: string; limit?: number } = {}): RbacAuditEvent[] {
  let rows = [...store().rbacAudit];
  if (filter.targetOid) rows = rows.filter((r) => r.targetOid === filter.targetOid);
  rows.sort((a, b) => (a.at < b.at ? 1 : -1));
  return rows.slice(0, Math.min(filter.limit ?? 100, 500));
}

// ------------------------------------------------------------
// Atomic commit
//
// Both the assignment mutation and its audit event land, or neither does. The
// `fail` seams exist so tests can force a persistence or audit failure and
// prove the rollback rather than trusting it.
// ------------------------------------------------------------
export interface FailureInjection {
  failAssignmentWrite?: boolean;
  failAuditWrite?: boolean;
}

export interface CommitResult {
  ok: boolean;
  reason?: string;
  assignment?: RoleAssignment;
}

export function commitAtomically(
  mutate: () => RoleAssignment,
  audit: Omit<RbacAuditEvent, 'id' | 'at'>,
  inject: FailureInjection = {}
): CommitResult {
  const d = store();
  const assignmentsBefore = d.rbacAssignments.map((a) => ({ ...a }));
  const auditBefore = d.rbacAudit.length;
  try {
    if (inject.failAssignmentWrite) throw new Error('assignment_persistence_failure');
    const assignment = mutate();

    if (inject.failAuditWrite) throw new Error('audit_persistence_failure');
    d.rbacAudit.push({ id: uuid(), at: nowIso(), ...audit });

    save();
    return { ok: true, assignment };
  } catch (e) {
    // Roll the store back to its pre-mutation state. No partial access change
    // and no orphaned audit row survives a failure.
    d.rbacAssignments.length = 0;
    d.rbacAssignments.push(...assignmentsBefore);
    d.rbacAudit.length = auditBefore;
    const reason = e instanceof Error && /audit_/.test(e.message) ? 'audit_persistence_failure' : 'assignment_persistence_failure';
    return { ok: false, reason };
  }
}

// Audit-only write, for refusals where nothing is mutated.
export function writeRbacAudit(event: Omit<RbacAuditEvent, 'id' | 'at'>): RbacAuditEvent {
  const row: RbacAuditEvent = { id: uuid(), at: nowIso(), ...event };
  store().rbacAudit.push(row);
  save();
  return row;
}

// ------------------------------------------------------------
// Mutations (called only inside commitAtomically)
// ------------------------------------------------------------
export function upsertActiveAssignment(input: {
  targetOid: string;
  targetDisplayName: string | null;
  targetUpn: string | null;
  role: WatsonRoleKey;
  source: AssignmentSource;
  actorOid: string;
}): RoleAssignment {
  const d = store();
  const existing = findActive(input.targetOid, input.role);
  // Idempotent: an already-held role never produces a second active row.
  if (existing) return existing;

  const now = nowIso();
  const row: RoleAssignment = {
    assignmentId: uuid(),
    targetOid: input.targetOid,
    targetDisplayName: input.targetDisplayName,
    targetUpn: input.targetUpn,
    role: input.role,
    active: true,
    source: input.source,
    assignedAt: now,
    assignedByOid: input.actorOid,
    modifiedAt: now,
    modifiedByOid: input.actorOid,
    removedAt: null,
    removedByOid: null,
    version: 1
  };
  d.rbacAssignments.push(row);
  return row;
}

export function deactivateAssignment(input: {
  targetOid: string;
  role: WatsonRoleKey;
  actorOid: string;
}): RoleAssignment {
  const existing = findActive(input.targetOid, input.role);
  if (!existing) throw new Error('not_active');
  const now = nowIso();
  existing.active = false;
  existing.removedAt = now;
  existing.removedByOid = input.actorOid;
  existing.modifiedAt = now;
  existing.modifiedByOid = input.actorOid;
  existing.version += 1;
  return existing;
}
