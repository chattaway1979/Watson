// ============================================================
// Watson — 021G : in-memory RBAC store adapter (tests + local development)
// ------------------------------------------------------------
// The REFERENCE implementation of the persistence contract. It defines the
// semantics the Postgres adapter must match, and it is what the focused tests
// run against, so the atomicity rules are asserted without needing a database.
//
// ATOMICITY ON A SINGLE-THREADED RUNTIME
// JavaScript only yields at `await`. Every critical section here is therefore
// written as a synchronous block with NO await inside it, which makes it
// genuinely atomic with respect to concurrent callers in the same process. That
// is not a shortcut — it is the same invariant the Postgres adapter achieves
// with a transaction and row locks, expressed in the runtime we actually have.
// Where a test needs to prove the invariant, it fires overlapping promises and
// asserts exactly one wins.
// ============================================================
import type { WatsonRoleKey } from './roles';
import type { RoleAssignment, RbacAuditEvent } from './store';
import type {
  RbacStoreAdapter, PersistenceResult, MutationOutcome, GrantInput, RevokeInput,
  PreviewRecord, PreviewBinding, PreviewConsume, BootstrapOutcome
} from './persistence';

let seq = 0;
const nextId = (p: string) => `${p}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export interface MemoryFailureInjection {
  failAssignmentWrite?: boolean;
  failAuditWrite?: boolean;
  unavailable?: boolean;
}

export class MemoryRbacStore implements RbacStoreAdapter {
  readonly kind = 'memory' as const;
  private assignments: RoleAssignment[] = [];
  private audit: RbacAuditEvent[] = [];
  private previews = new Map<string, PreviewRecord & { consumed: boolean }>();
  inject: MemoryFailureInjection = {};

  reset(): void {
    this.assignments = []; this.audit = []; this.previews.clear(); this.inject = {};
  }

  async ping(): Promise<boolean> { return !this.inject.unavailable; }

  private guard(): void {
    if (this.inject.unavailable) throw new Error('store_unavailable');
  }

  // ---- reads -------------------------------------------------------------
  private activeRolesSync(oid: string): WatsonRoleKey[] {
    return [...new Set(this.assignments.filter((a) => a.targetOid === oid && a.active).map((a) => a.role))]
      .sort() as WatsonRoleKey[];
  }
  private adminCountSync(): number {
    return new Set(this.assignments.filter((a) => a.active && a.role === 'watson_role_admin').map((a) => a.targetOid)).size;
  }
  private versionSync(oid: string): number {
    return this.assignments.filter((a) => a.targetOid === oid).reduce((n, a) => n + a.version, 0);
  }

  async activeRoles(oid: string): Promise<WatsonRoleKey[]> { this.guard(); return this.activeRolesSync(oid); }
  async activeAssignments(oid: string): Promise<RoleAssignment[]> {
    this.guard(); return this.assignments.filter((a) => a.targetOid === oid && a.active).map((a) => ({ ...a }));
  }
  async countActiveRoleAdmins(): Promise<number> { this.guard(); return this.adminCountSync(); }
  async roleStateVersion(oid: string): Promise<number> { this.guard(); return this.versionSync(oid); }
  async listAudit(filter: { targetOid?: string; limit?: number } = {}): Promise<RbacAuditEvent[]> {
    this.guard();
    let rows = [...this.audit];
    if (filter.targetOid) rows = rows.filter((r) => r.targetOid === filter.targetOid);
    rows.sort((a, b) => (a.at < b.at ? 1 : -1));
    return rows.slice(0, Math.min(filter.limit ?? 100, 500)).map((r) => ({ ...r }));
  }

  // Test-only: the audit log must be append-only from the application's view.
  auditRowCount(): number { return this.audit.length; }
  allAssignments(): readonly RoleAssignment[] { return this.assignments; }

  private appendAuditSync(e: Omit<RbacAuditEvent, 'id' | 'at'>): void {
    this.audit.push({ id: nextId('aud'), at: new Date().toISOString(), ...e });
  }

  async appendAudit(e: Omit<RbacAuditEvent, 'id' | 'at'>): Promise<PersistenceResult<void>> {
    try { this.guard(); } catch { return { ok: false, reason: 'store_unavailable' }; }
    if (this.inject.failAuditWrite) return { ok: false, reason: 'audit_failure' };
    this.appendAuditSync(e);
    return { ok: true, data: undefined };
  }

  // ---- atomic grant ------------------------------------------------------
  async grantRole(i: GrantInput): Promise<PersistenceResult<MutationOutcome>> {
    try { this.guard(); } catch { return { ok: false, reason: 'store_unavailable' }; }
    // ---- critical section: no await below until it completes ----
    const before = this.assignments.map((a) => ({ ...a }));
    const auditBefore = this.audit.length;
    try {
      if (this.inject.failAssignmentWrite) throw new Error('assignment');
      const existing = this.assignments.find((a) => a.targetOid === i.targetOid && a.role === i.role && a.active);
      if (existing) {
        // Idempotent: an already-held role never produces a second active row.
        this.appendAuditSync({
          correlationId: i.correlationId, actorOid: i.actorOid, actorUpn: i.actorUpn,
          targetOid: i.targetOid, operation: 'assign_confirm', outcome: 'success',
          reason: 'idempotent_already_assigned', previousRoles: i.previousRoles,
          resultingRoles: i.previousRoles, source: 'administrator',
          elevatedAcknowledged: i.elevatedAcknowledged
        });
        return { ok: true, data: { applied: false, idempotent: true, roles: this.activeRolesSync(i.targetOid) } };
      }
      const now = new Date().toISOString();
      this.assignments.push({
        assignmentId: nextId('asg'), targetOid: i.targetOid, targetDisplayName: i.targetDisplayName,
        targetUpn: i.targetUpn, role: i.role, active: true, source: i.source,
        assignedAt: now, assignedByOid: i.actorOid, modifiedAt: now, modifiedByOid: i.actorOid,
        removedAt: null, removedByOid: null, version: 1
      });
      if (this.inject.failAuditWrite) throw new Error('audit');
      this.appendAuditSync({
        correlationId: i.correlationId, actorOid: i.actorOid, actorUpn: i.actorUpn,
        targetOid: i.targetOid, operation: 'assign_confirm', outcome: 'success',
        reason: 'role_assigned', previousRoles: i.previousRoles, resultingRoles: i.resultingRoles,
        source: i.source, elevatedAcknowledged: i.elevatedAcknowledged
      });
      return { ok: true, data: { applied: true, idempotent: false, roles: this.activeRolesSync(i.targetOid) } };
    } catch (e) {
      // Roll back to the pre-mutation snapshot: no assignment without its audit,
      // and no audit row describing a change that did not happen.
      this.assignments = before;
      this.audit.length = auditBefore;
      return { ok: false, reason: (e as Error).message === 'audit' ? 'audit_failure' : 'persistence_failure' };
    }
  }

  // ---- atomic revoke, WITH final-admin protection inside the boundary -----
  async revokeRole(i: RevokeInput): Promise<PersistenceResult<MutationOutcome>> {
    try { this.guard(); } catch { return { ok: false, reason: 'store_unavailable' }; }
    // ---- critical section ----
    const before = this.assignments.map((a) => ({ ...a }));
    const auditBefore = this.audit.length;
    try {
      const existing = this.assignments.find((a) => a.targetOid === i.targetOid && a.role === i.role && a.active);
      if (!existing) {
        this.appendAuditSync({
          correlationId: i.correlationId, actorOid: i.actorOid, actorUpn: i.actorUpn,
          targetOid: i.targetOid, operation: 'remove_confirm', outcome: 'success',
          reason: 'idempotent_not_assigned', previousRoles: i.previousRoles,
          resultingRoles: i.previousRoles, source: 'administrator',
          elevatedAcknowledged: i.elevatedAcknowledged
        });
        return { ok: true, data: { applied: false, idempotent: true, roles: this.activeRolesSync(i.targetOid) } };
      }
      // THE INVARIANT: counted and acted upon without yielding, so two
      // concurrent removals cannot both observe "2 admins" and both proceed.
      if (i.role === 'watson_role_admin' && this.adminCountSync() <= 1) {
        this.appendAuditSync({
          correlationId: i.correlationId, actorOid: i.actorOid, actorUpn: i.actorUpn,
          targetOid: i.targetOid, operation: 'remove_confirm', outcome: 'refused',
          reason: 'last_admin_protected', previousRoles: i.previousRoles,
          resultingRoles: i.previousRoles, source: 'administrator', elevatedAcknowledged: i.elevatedAcknowledged
        });
        return { ok: false, reason: 'last_admin_protected' };
      }
      if (this.inject.failAssignmentWrite) throw new Error('assignment');
      const now = new Date().toISOString();
      existing.active = false; existing.removedAt = now; existing.removedByOid = i.actorOid;
      existing.modifiedAt = now; existing.modifiedByOid = i.actorOid; existing.version += 1;
      if (this.inject.failAuditWrite) throw new Error('audit');
      this.appendAuditSync({
        correlationId: i.correlationId, actorOid: i.actorOid, actorUpn: i.actorUpn,
        targetOid: i.targetOid, operation: 'remove_confirm', outcome: 'success',
        reason: 'role_removed', previousRoles: i.previousRoles, resultingRoles: i.resultingRoles,
        source: 'administrator', elevatedAcknowledged: i.elevatedAcknowledged
      });
      return { ok: true, data: { applied: true, idempotent: false, roles: this.activeRolesSync(i.targetOid) } };
    } catch (e) {
      this.assignments = before;
      this.audit.length = auditBefore;
      return { ok: false, reason: (e as Error).message === 'audit' ? 'audit_failure' : 'persistence_failure' };
    }
  }

  // ---- previews ----------------------------------------------------------
  async putPreview(r: PreviewRecord): Promise<PersistenceResult<void>> {
    try { this.guard(); } catch { return { ok: false, reason: 'store_unavailable' }; }
    this.previews.set(r.digest, { ...r, consumed: false });
    return { ok: true, data: undefined };
  }

  async consumePreview(digest: string, b: PreviewBinding, nowMs: number): Promise<PreviewConsume> {
    this.guard();
    // ---- critical section: check-and-consume without yielding ----
    const p = this.previews.get(digest);
    // An unknown digest is 'stale' — deliberately indistinguishable from expired,
    // so a caller cannot probe for which nonces exist.
    if (!p || p.operation !== b.operation) return { ok: false, reason: 'stale_preview' };
    if (p.consumed) return { ok: false, reason: 'replayed_preview' };
    if (Date.parse(p.expiresAt) <= nowMs) return { ok: false, reason: 'stale_preview' };
    if (p.actorOid !== b.actorOid) return { ok: false, reason: 'actor_mismatch' };
    if (p.targetOid !== b.targetOid) return { ok: false, reason: 'target_mismatch' };
    if (p.role !== b.role) return { ok: false, reason: 'role_mismatch' };
    // Time-of-check/time-of-use: the target's roles must not have moved.
    const current = b.expectedStateVersion ?? this.versionSync(p.targetOid);
    if (current !== p.stateVersion) return { ok: false, reason: 'stale_preview' };
    p.consumed = true;                       // single-use, marked before returning
    return { ok: true, record: { ...p } };
  }

  async purgeExpiredPreviews(nowMs: number): Promise<number> {
    this.guard();
    let n = 0;
    for (const [k, v] of this.previews) {
      if (Date.parse(v.expiresAt) <= nowMs || v.consumed) { this.previews.delete(k); n++; }
    }
    return n;
  }

  previewCount(): number { return this.previews.size; }
  // Test-only: expose the stored rows so a leakage assertion can inspect what is
  // ACTUALLY persisted rather than a Map that stringifies to {}.
  dumpPreviewsForTests(): Array<Record<string, unknown>> {
    return [...this.previews.values()].map((v) => ({ ...v }));
  }

  // ---- bootstrap ---------------------------------------------------------
  async tryBootstrap(oid: string, correlationId: string): Promise<PersistenceResult<BootstrapOutcome>> {
    try { this.guard(); } catch { return { ok: false, reason: 'store_unavailable' }; }
    // ---- critical section: count-and-create atomically ----
    if (this.adminCountSync() > 0) {
      this.appendAuditSync({
        correlationId, actorOid: 'system:bootstrap', actorUpn: null, targetOid: oid,
        operation: 'bootstrap', outcome: 'refused', reason: 'persistent_admin_exists',
        previousRoles: null, resultingRoles: null, source: 'bootstrap', elevatedAcknowledged: null
      });
      return { ok: true, data: { applied: false, reason: 'persistent_admin_exists' } };
    }
    const now = new Date().toISOString();
    this.assignments.push({
      assignmentId: nextId('asg'), targetOid: oid, targetDisplayName: null, targetUpn: null,
      role: 'watson_role_admin', active: true, source: 'bootstrap',
      assignedAt: now, assignedByOid: 'system:bootstrap', modifiedAt: now,
      modifiedByOid: 'system:bootstrap', removedAt: null, removedByOid: null, version: 1
    });
    this.appendAuditSync({
      correlationId, actorOid: 'system:bootstrap', actorUpn: null, targetOid: oid,
      operation: 'bootstrap', outcome: 'success', reason: 'bootstrap_role_admin_created',
      previousRoles: [], resultingRoles: ['watson_role_admin'], source: 'bootstrap',
      elevatedAcknowledged: null
    });
    return { ok: true, data: { applied: true, reason: 'bootstrap_role_admin_created' } };
  }

  // ---- migration support -------------------------------------------------
  // Used only by the migration tool. Rejects a duplicate assignmentId so a rerun
  // is idempotent rather than additive.
  importAssignment(a: RoleAssignment): 'inserted' | 'skipped' {
    if (this.assignments.some((x) => x.assignmentId === a.assignmentId)) return 'skipped';
    this.assignments.push({ ...a });
    return 'inserted';
  }
  importAudit(e: RbacAuditEvent): 'inserted' | 'skipped' {
    if (this.audit.some((x) => x.id === e.id)) return 'skipped';
    this.audit.push({ ...e });
    return 'inserted';
  }
}
