// ============================================================
// Watson — 021G-2 : JSON RBAC adapter (SERVER-ONLY)
// ------------------------------------------------------------
// Wraps the existing single-instance JSON store in the asynchronous persistence
// contract so the RBAC service can be converted to async NOW, without a database
// and without touching the deployed staging runtime.
//
// THIS ADAPTER IS NOT MULTI-INSTANCE SAFE, and nothing here claims otherwise.
// It stores state in one process's memory plus one JSON file, so two App Service
// workers would still disagree. It exists to keep staging working unchanged
// until 021G-3 swaps in the Postgres adapter behind the same contract.
//
// What it DOES guarantee, within one process:
//   * mutations are SERIALIZED through a promise queue, so two overlapping
//     requests cannot interleave a read-modify-write on the JSON document;
//   * grant/revoke and their audit rows commit together or roll back together;
//   * final-administrator protection is evaluated inside the serialized section,
//     never as a separate count-then-delete by the caller;
//   * preview nonces are stored as digests and consumed atomically.
//
// Preview nonces live in the process (the JSON document is deliberately NOT
// given a nonce collection, so the on-disk format is unchanged and rollback
// stays trivial). That is the precise limitation 021G-3 removes.
// ============================================================
import type { WatsonRoleKey } from './roles';
import { db, save } from '../../store/db';
import type { RoleAssignment, RbacAuditEvent } from './store';
import {
  activeRoles as jsonActiveRoles, activeAssignments as jsonActiveAssignments,
  countActiveRoleAdmins as jsonCountAdmins, roleStateVersion as jsonStateVersion,
  listAudit as jsonListAudit, findActive, upsertActiveAssignment, deactivateAssignment,
  commitAtomically, writeRbacAudit
} from './store';
import type {
  RbacStoreAdapter, PersistenceResult, MutationOutcome, GrantInput, RevokeInput,
  PreviewRecord, PreviewBinding, PreviewConsume, BootstrapOutcome
} from './persistence';

// ------------------------------------------------------------
// Serialization. Every mutation runs to completion before the next begins, so a
// read-modify-write on the shared JSON document cannot interleave. Reads are not
// queued: they are synchronous snapshots and cannot tear.
// ------------------------------------------------------------
const g = globalThis as unknown as {
  __watsonJsonRbacQueue?: Promise<unknown>;
  __watsonJsonPreviews?: Map<string, PreviewRecord & { consumed: boolean }>;
};

function queue<T>(fn: () => T): Promise<T> {
  const prev = g.__watsonJsonRbacQueue ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // Keep the chain alive but never let a rejection poison later callers.
  g.__watsonJsonRbacQueue = next.then(() => undefined, () => undefined);
  return next;
}

function previews(): Map<string, PreviewRecord & { consumed: boolean }> {
  if (!g.__watsonJsonPreviews) g.__watsonJsonPreviews = new Map();
  return g.__watsonJsonPreviews;
}

export class JsonRbacStore implements RbacStoreAdapter {
  readonly kind = 'json_legacy' as const;

  // The JSON store is a local file; if db() answers, it is usable. A thrown
  // error propagates as unavailable rather than being swallowed.
  async ping(): Promise<boolean> {
    try { db(); return true; } catch { return false; }
  }

  async activeRoles(oid: string): Promise<WatsonRoleKey[]> { return jsonActiveRoles(oid); }
  async activeAssignments(oid: string): Promise<RoleAssignment[]> { return jsonActiveAssignments(oid); }
  async countActiveRoleAdmins(): Promise<number> { return jsonCountAdmins(); }
  async roleStateVersion(oid: string): Promise<number> { return jsonStateVersion(oid); }
  async listAudit(filter: { targetOid?: string; limit?: number } = {}): Promise<RbacAuditEvent[]> {
    return jsonListAudit(filter);
  }

  async appendAudit(e: Omit<RbacAuditEvent, 'id' | 'at'>): Promise<PersistenceResult<void>> {
    return queue(() => {
      try { writeRbacAudit(e); return { ok: true as const, data: undefined }; }
      catch { return { ok: false as const, reason: 'audit_failure' as const }; }
    });
  }

  async grantRole(i: GrantInput): Promise<PersistenceResult<MutationOutcome>> {
    return queue(() => {
      // Idempotent: an already-held role never produces a second active row.
      if (findActive(i.targetOid, i.role)) {
        writeRbacAudit({
          correlationId: i.correlationId, actorOid: i.actorOid, actorUpn: i.actorUpn,
          targetOid: i.targetOid, operation: 'assign_confirm', outcome: 'success',
          reason: 'idempotent_already_assigned', previousRoles: i.previousRoles,
          resultingRoles: i.previousRoles, source: 'administrator',
          elevatedAcknowledged: i.elevatedAcknowledged
        });
        return { ok: true as const, data: { applied: false, idempotent: true, roles: jsonActiveRoles(i.targetOid) } };
      }
      const commit = commitAtomically(
        () => upsertActiveAssignment({
          targetOid: i.targetOid, targetDisplayName: i.targetDisplayName,
          targetUpn: i.targetUpn, role: i.role, source: i.source, actorOid: i.actorOid
        }),
        {
          correlationId: i.correlationId, actorOid: i.actorOid, actorUpn: i.actorUpn,
          targetOid: i.targetOid, operation: 'assign_confirm', outcome: 'success',
          reason: 'role_assigned', previousRoles: i.previousRoles, resultingRoles: i.resultingRoles,
          source: i.source, elevatedAcknowledged: i.elevatedAcknowledged
        },
        i.inject
      );
      if (!commit.ok) {
        return { ok: false as const, reason: commit.reason === 'audit_persistence_failure' ? 'audit_failure' as const : 'persistence_failure' as const };
      }
      return { ok: true as const, data: { applied: true, idempotent: false, roles: jsonActiveRoles(i.targetOid) } };
    });
  }

  async revokeRole(i: RevokeInput): Promise<PersistenceResult<MutationOutcome>> {
    return queue(() => {
      if (!findActive(i.targetOid, i.role)) {
        writeRbacAudit({
          correlationId: i.correlationId, actorOid: i.actorOid, actorUpn: i.actorUpn,
          targetOid: i.targetOid, operation: 'remove_confirm', outcome: 'success',
          reason: 'idempotent_not_assigned', previousRoles: i.previousRoles,
          resultingRoles: i.previousRoles, source: 'administrator',
          elevatedAcknowledged: i.elevatedAcknowledged
        });
        return { ok: true as const, data: { applied: false, idempotent: true, roles: jsonActiveRoles(i.targetOid) } };
      }
      // FINAL-ADMINISTRATOR PROTECTION, inside the serialized section. The caller
      // cannot count-then-remove as two steps, so two overlapping removals cannot
      // both observe "two administrators" and both proceed.
      if (i.role === 'watson_role_admin' && jsonCountAdmins() <= 1) {
        writeRbacAudit({
          correlationId: i.correlationId, actorOid: i.actorOid, actorUpn: i.actorUpn,
          targetOid: i.targetOid, operation: 'remove_confirm', outcome: 'refused',
          reason: 'last_admin_protected', previousRoles: i.previousRoles,
          resultingRoles: i.previousRoles, source: 'administrator',
          elevatedAcknowledged: i.elevatedAcknowledged
        });
        return { ok: false as const, reason: 'last_admin_protected' as const };
      }
      const commit = commitAtomically(
        () => deactivateAssignment({ targetOid: i.targetOid, role: i.role, actorOid: i.actorOid }),
        {
          correlationId: i.correlationId, actorOid: i.actorOid, actorUpn: i.actorUpn,
          targetOid: i.targetOid, operation: 'remove_confirm', outcome: 'success',
          reason: 'role_removed', previousRoles: i.previousRoles, resultingRoles: i.resultingRoles,
          source: 'administrator', elevatedAcknowledged: i.elevatedAcknowledged
        },
        i.inject
      );
      if (!commit.ok) {
        return { ok: false as const, reason: commit.reason === 'audit_persistence_failure' ? 'audit_failure' as const : 'persistence_failure' as const };
      }
      return { ok: true as const, data: { applied: true, idempotent: false, roles: jsonActiveRoles(i.targetOid) } };
    });
  }

  async putPreview(r: PreviewRecord): Promise<PersistenceResult<void>> {
    previews().set(r.digest, { ...r, consumed: false });
    return { ok: true, data: undefined };
  }

  async consumePreview(digest: string, b: PreviewBinding, nowMs: number): Promise<PreviewConsume> {
    // Serialized so check-and-consume cannot interleave with another confirmation.
    return queue(() => {
      const p = previews().get(digest);
      // Unknown and expired are deliberately indistinguishable: no existence oracle.
      if (!p || p.operation !== b.operation) return { ok: false as const, reason: 'stale_preview' as const };
      if (p.consumed) return { ok: false as const, reason: 'replayed_preview' as const };
      if (Date.parse(p.expiresAt) <= nowMs) return { ok: false as const, reason: 'stale_preview' as const };
      if (p.actorOid !== b.actorOid) return { ok: false as const, reason: 'actor_mismatch' as const };
      if (p.targetOid !== b.targetOid) return { ok: false as const, reason: 'target_mismatch' as const };
      if (p.role !== b.role) return { ok: false as const, reason: 'role_mismatch' as const };
      const current = b.expectedStateVersion ?? jsonStateVersion(p.targetOid);
      if (current !== p.stateVersion) return { ok: false as const, reason: 'stale_preview' as const };
      p.consumed = true;
      return { ok: true as const, record: { ...p } };
    });
  }

  async purgeExpiredPreviews(nowMs: number): Promise<number> {
    return queue(() => {
      let n = 0;
      for (const [k, v] of previews()) {
        if (Date.parse(v.expiresAt) <= nowMs || v.consumed) { previews().delete(k); n++; }
      }
      return n;
    });
  }

  async tryBootstrap(oid: string, correlationId: string): Promise<PersistenceResult<BootstrapOutcome>> {
    // Serialized: concurrent initialization cannot create two bootstrap records.
    return queue(() => {
      if (jsonCountAdmins() > 0) {
        writeRbacAudit({
          correlationId, actorOid: 'system:bootstrap', actorUpn: null, targetOid: oid,
          operation: 'bootstrap', outcome: 'refused', reason: 'persistent_admin_exists',
          previousRoles: null, resultingRoles: null, source: 'bootstrap', elevatedAcknowledged: null
        });
        return { ok: true as const, data: { applied: false, reason: 'persistent_admin_exists' as const } };
      }
      const commit = commitAtomically(
        () => upsertActiveAssignment({
          targetOid: oid, targetDisplayName: null, targetUpn: null,
          role: 'watson_role_admin', source: 'bootstrap', actorOid: 'system:bootstrap'
        }),
        {
          correlationId, actorOid: 'system:bootstrap', actorUpn: null, targetOid: oid,
          operation: 'bootstrap', outcome: 'success', reason: 'bootstrap_role_admin_created',
          previousRoles: [], resultingRoles: ['watson_role_admin'], source: 'bootstrap',
          elevatedAcknowledged: null
        }
      );
      if (!commit.ok) return { ok: false as const, reason: 'persistence_failure' as const };
      save();
      return { ok: true as const, data: { applied: true, reason: 'bootstrap_role_admin_created' as const } };
    });
  }

  // Test/diagnostic seams.
  previewCount(): number { return previews().size; }
  __resetPreviewsForTests(): void { previews().clear(); }
}
