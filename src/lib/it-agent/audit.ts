// ============================================================
// Watson — H&R AI IT Agent : Audit Logger (backend-owned)
// Every meaningful event flows through here. UI never writes audit.
// ============================================================
import { db, save, uuid, nowIso } from '../store/db';
import type { AuditEventType, AuditLog, ActorType } from './types';

export interface AuditInput {
  actorType: ActorType;
  actorId: string;
  action: AuditEventType;
  targetType: string;
  targetId: string;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
}

export function writeAudit(input: AuditInput): AuditLog {
  const entry: AuditLog = {
    id: uuid(),
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    beforeState: input.beforeState ?? null,
    afterState: input.afterState ?? null,
    metadata: input.metadata ?? null,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    createdAt: nowIso()
  };
  db().auditLogs.push(entry);
  save();
  return entry;
}

export function listAudit(filter?: {
  targetType?: string;
  targetId?: string;
  action?: AuditEventType;
  limit?: number;
}): AuditLog[] {
  let rows = [...db().auditLogs].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  if (filter?.targetType) rows = rows.filter((r) => r.targetType === filter.targetType);
  if (filter?.targetId) rows = rows.filter((r) => r.targetId === filter.targetId);
  if (filter?.action) rows = rows.filter((r) => r.action === filter.action);
  if (filter?.limit) rows = rows.slice(0, filter.limit);
  return rows;
}
