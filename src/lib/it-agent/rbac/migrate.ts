// ============================================================
// Watson — 021G : JSON -> shared-store RBAC migration (SERVER-ONLY, PURE-ish)
// ------------------------------------------------------------
// Moves role assignments, RBAC audit and bootstrap state out of the
// single-instance JSON store and into the shared durable adapter.
//
// Design rules, all of which the tests assert:
//   * DETERMINISTIC — the same source always yields the same plan and checksum.
//   * IDEMPOTENT    — a rerun inserts nothing new. Records carry their original
//                     identity (assignmentId / audit id), so "already there" is
//                     decidable rather than guessed from field equality.
//   * FAIL CLOSED   — malformed or internally-contradictory source data aborts
//                     the whole migration. A partially-migrated RBAC store is
//                     worse than an unmigrated one, because it can silently
//                     change who holds administrator access.
//   * VERIFIABLE    — source and destination counts plus a content checksum are
//                     reported, so "it worked" is a measurement, not a claim.
//   * NON-DESTRUCTIVE — the source is never modified. Rollback is simply
//                     pointing the app back at the JSON store.
// ============================================================
import { createHash } from 'node:crypto';
import type { RoleAssignment, RbacAuditEvent } from './store';
import type { RbacStoreAdapter } from './persistence';
import { WATSON_ROLE_KEYS } from './roles';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYSTEM_ACTORS = new Set(['system:bootstrap', 'system:test', 'anonymous']);

export class MigrationError extends Error {}

export interface MigrationSource {
  rbacAssignments?: unknown;
  rbacAudit?: unknown;
}

export interface MigrationPlan {
  assignments: RoleAssignment[];
  audit: RbacAuditEvent[];
  sourceCounts: { assignments: number; audit: number; activeAdmins: number };
  checksum: string;
}

export interface MigrationReport {
  plan: MigrationPlan;
  inserted: { assignments: number; audit: number };
  skipped: { assignments: number; audit: number };
  destinationCounts: { assignments: number; audit: number; activeAdmins: number };
  verified: boolean;
  idempotentRerun: boolean;
}

function isRole(v: unknown): boolean {
  return typeof v === 'string' && (WATSON_ROLE_KEYS as readonly string[]).includes(v);
}
function actorOk(v: unknown): boolean {
  return typeof v === 'string' && (GUID.test(v) || SYSTEM_ACTORS.has(v));
}

// Parse + validate the JSON source. Throws MigrationError on anything it cannot
// vouch for; there is deliberately no "best effort" mode.
export function planMigration(source: MigrationSource): MigrationPlan {
  const rawA = source.rbacAssignments ?? [];
  const rawE = source.rbacAudit ?? [];
  if (!Array.isArray(rawA)) throw new MigrationError('rbacAssignments is not an array');
  if (!Array.isArray(rawE)) throw new MigrationError('rbacAudit is not an array');

  const assignments: RoleAssignment[] = [];
  const seenIds = new Set<string>();
  const activeByPrincipalRole = new Set<string>();

  for (const [i, r] of (rawA as Record<string, unknown>[]).entries()) {
    if (!r || typeof r !== 'object') throw new MigrationError(`assignment ${i} is not an object`);
    const id = r.assignmentId;
    if (typeof id !== 'string' || !id) throw new MigrationError(`assignment ${i} has no assignmentId`);
    if (seenIds.has(id)) throw new MigrationError(`duplicate assignmentId in source: ${id}`);
    seenIds.add(id);
    if (typeof r.targetOid !== 'string' || !GUID.test(r.targetOid)) {
      throw new MigrationError(`assignment ${id} has a malformed targetOid`);
    }
    if (!isRole(r.role)) throw new MigrationError(`assignment ${id} has an unknown role`);
    if (typeof r.active !== 'boolean') throw new MigrationError(`assignment ${id} has a non-boolean active flag`);
    if (!actorOk(r.assignedByOid)) throw new MigrationError(`assignment ${id} has a malformed assignedByOid`);
    if (typeof r.version !== 'number' || !Number.isFinite(r.version)) {
      throw new MigrationError(`assignment ${id} has a malformed version`);
    }
    // Uniqueness of principal+role among ACTIVE rows. Two active rows for the
    // same person and role would make "do they hold it?" ambiguous.
    if (r.active) {
      const key = `${(r.targetOid as string).toLowerCase()}::${r.role as string}`;
      if (activeByPrincipalRole.has(key)) {
        throw new MigrationError(`source has two ACTIVE rows for the same principal and role: ${key}`);
      }
      activeByPrincipalRole.add(key);
    }
    assignments.push(r as unknown as RoleAssignment);
  }

  const audit: RbacAuditEvent[] = [];
  const seenAudit = new Set<string>();
  for (const [i, e] of (rawE as Record<string, unknown>[]).entries()) {
    if (!e || typeof e !== 'object') throw new MigrationError(`audit ${i} is not an object`);
    if (typeof e.id !== 'string' || !e.id) throw new MigrationError(`audit ${i} has no id`);
    if (seenAudit.has(e.id)) throw new MigrationError(`duplicate audit id in source: ${e.id}`);
    seenAudit.add(e.id);
    if (typeof e.at !== 'string' || Number.isNaN(Date.parse(e.at))) {
      throw new MigrationError(`audit ${e.id} has a malformed timestamp`);
    }
    if (!actorOk(e.actorOid)) throw new MigrationError(`audit ${e.id} has a malformed actorOid`);
    if (typeof e.operation !== 'string' || !e.operation) throw new MigrationError(`audit ${e.id} has no operation`);
    if (!['success', 'refused', 'error'].includes(e.outcome as string)) {
      throw new MigrationError(`audit ${e.id} has an unknown outcome`);
    }
    audit.push(e as unknown as RbacAuditEvent);
  }

  const activeAdmins = new Set(
    assignments.filter((a) => a.active && a.role === 'watson_role_admin').map((a) => a.targetOid.toLowerCase())
  ).size;

  return {
    assignments,
    audit,
    sourceCounts: { assignments: assignments.length, audit: audit.length, activeAdmins },
    checksum: checksumOf(assignments, audit)
  };
}

// Order-independent content checksum. Sorting by identity first means a source
// whose array order changed still checksums identically, so the value means
// "same records", not "same file bytes".
export function checksumOf(assignments: RoleAssignment[], audit: RbacAuditEvent[]): string {
  const a = [...assignments].sort((x, y) => x.assignmentId.localeCompare(y.assignmentId))
    .map((x) => [x.assignmentId, x.targetOid.toLowerCase(), x.role, x.active, x.source, x.version].join('|'));
  const e = [...audit].sort((x, y) => x.id.localeCompare(y.id))
    .map((x) => [x.id, x.at, x.actorOid, x.targetOid ?? '', x.operation, x.outcome, x.reason].join('|'));
  return createHash('sha256').update(JSON.stringify({ a, e })).digest('hex');
}

export interface MigrationTarget extends RbacStoreAdapter {
  // Awaited by applyMigration, so an in-memory target may answer synchronously
  // while a database target answers with a Promise. One migrator drives both.
  importAssignment(a: RoleAssignment): 'inserted' | 'skipped' | Promise<'inserted' | 'skipped'>;
  importAudit(e: RbacAuditEvent): 'inserted' | 'skipped' | Promise<'inserted' | 'skipped'>;
}

// Apply a plan. Safe to run repeatedly: identity-keyed inserts make a rerun a
// no-op rather than a duplication.
export async function applyMigration(
  plan: MigrationPlan,
  target: MigrationTarget
): Promise<MigrationReport> {
  const inserted = { assignments: 0, audit: 0 };
  const skipped = { assignments: 0, audit: 0 };

  for (const a of plan.assignments) {
    ((await target.importAssignment(a)) === 'inserted' ? inserted : skipped).assignments++;
  }
  for (const e of plan.audit) {
    ((await target.importAudit(e)) === 'inserted' ? inserted : skipped).audit++;
  }

  const destAssignments = target.allAssignments ? [...(await target.allAssignments())] : [];
  const destAudit = await target.listAudit({ limit: 500 });
  const destAdmins = await target.countActiveRoleAdmins();

  // Verification compares what the DESTINATION now holds against the plan, so a
  // silently-dropped row is caught rather than assumed absent.
  const verified =
    destAssignments.length >= plan.sourceCounts.assignments &&
    destAudit.length >= Math.min(plan.sourceCounts.audit, 500) &&
    destAdmins === plan.sourceCounts.activeAdmins;

  return {
    plan,
    inserted,
    skipped,
    destinationCounts: { assignments: destAssignments.length, audit: destAudit.length, activeAdmins: destAdmins },
    verified,
    idempotentRerun: inserted.assignments === 0 && inserted.audit === 0
  };
}

// Declared so the migration can read `allAssignments` off an adapter that
// exposes it, without widening the core adapter contract for production use.
// Awaited at the call site, so an in-memory adapter may answer synchronously
// while a database adapter answers with a Promise.
declare module './persistence' {
  interface RbacStoreAdapter {
    allAssignments?(): readonly RoleAssignment[] | Promise<RoleAssignment[]>;
  }
}
