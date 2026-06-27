// ============================================================
// Watson — H&R AI IT Agent : Ticket Service
// ============================================================
import { db, save, uuid, nowIso, nextId } from '../store/db';
import { writeAudit } from './audit';
import { canViewTicket, canManageTicket } from './policy';
import type {
  Actor, Ticket, TicketCategory, TicketStatus, Priority, TicketMessage, TicketEvent, AiDiagnosis, RecommendedAction
} from './types';

function shortId(n: number): string {
  return `WAT-${n}`;
}

export function createTicket(
  actor: Actor,
  input: {
    subject: string;
    description: string;
    category: TicketCategory;
    priority?: Priority;
    requesterEmail?: string;
    requesterName?: string;
    aiDiagnosis?: AiDiagnosis | null;
    recommendedActions?: RecommendedAction[];
    tags?: string[];
  }
): Ticket {
  const n = nextId('ticket');
  const ticket: Ticket = {
    id: uuid(),
    shortId: shortId(n),
    subject: input.subject.trim() || 'IT Support Request',
    description: input.description.trim(),
    category: input.category,
    status: 'open',
    priority: input.priority ?? 'normal',
    requesterId: actor.id,
    requesterEmail: input.requesterEmail ?? actor.email ?? 'unknown@hrelectriccompany.com',
    requesterName: input.requesterName ?? actor.displayName,
    assigneeId: null,
    assigneeName: null,
    aiDiagnosis: input.aiDiagnosis ?? null,
    recommendedActions: input.recommendedActions ?? [],
    linkedApprovalIds: [],
    tags: input.tags ?? [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    triagedAt: input.aiDiagnosis ? nowIso() : null,
    resolvedAt: null,
    closedAt: null
  };
  db().tickets.push(ticket);
  addEvent(ticket.id, 'ticket_created', actor, `Ticket created (${ticket.category}/${ticket.priority}).`);
  writeAudit({
    actorType: actor.type, actorId: actor.id, action: 'ticket_created',
    targetType: 'ticket', targetId: ticket.shortId,
    afterState: { status: ticket.status, category: ticket.category, priority: ticket.priority }
  });
  if (input.aiDiagnosis) {
    writeAudit({
      actorType: 'agent', actorId: 'watson', action: 'agent_triage_completed',
      targetType: 'ticket', targetId: ticket.shortId,
      metadata: { category: input.aiDiagnosis.category, priority: input.aiDiagnosis.priority }
    });
  }
  save();
  return ticket;
}

export function getTicket(id: string): Ticket | undefined {
  return db().tickets.find((t) => t.id === id || t.shortId === id);
}

export function listTicketsFor(actor: Actor, filter?: { status?: TicketStatus; category?: TicketCategory; priority?: Priority }): Ticket[] {
  let rows = db().tickets.filter((t) => canViewTicket(actor, t));
  if (filter?.status) rows = rows.filter((t) => t.status === filter.status);
  if (filter?.category) rows = rows.filter((t) => t.category === filter.category);
  if (filter?.priority) rows = rows.filter((t) => t.priority === filter.priority);
  return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function listAllTickets(filter?: { status?: TicketStatus; category?: TicketCategory; priority?: Priority }): Ticket[] {
  let rows = [...db().tickets];
  if (filter?.status) rows = rows.filter((t) => t.status === filter.status);
  if (filter?.category) rows = rows.filter((t) => t.category === filter.category);
  if (filter?.priority) rows = rows.filter((t) => t.priority === filter.priority);
  return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

const ALLOWED_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  open: ['triaged', 'in_progress', 'waiting_on_employee', 'waiting_on_admin', 'approval_required', 'cancelled', 'resolved'],
  triaged: ['in_progress', 'waiting_on_employee', 'waiting_on_admin', 'approval_required', 'resolved', 'cancelled'],
  waiting_on_employee: ['in_progress', 'triaged', 'resolved', 'cancelled', 'approval_required'],
  waiting_on_admin: ['in_progress', 'approval_required', 'resolved', 'cancelled', 'triaged'],
  approval_required: ['in_progress', 'waiting_on_admin', 'resolved', 'cancelled'],
  in_progress: ['waiting_on_employee', 'waiting_on_admin', 'approval_required', 'resolved', 'cancelled'],
  resolved: ['closed', 'in_progress'], // reopen
  closed: ['in_progress'], // reopen
  cancelled: ['open']
};

export function setStatus(actor: Actor, id: string, status: TicketStatus, note?: string): Ticket {
  const t = getTicket(id);
  if (!t) throw new Error('Ticket not found');
  if (!canManageTicket(actor, t) && t.requesterId !== actor.id) {
    throw new Error('Not authorized to change this ticket.');
  }
  // Employees may only cancel/reopen their own; managing transitions need manage rights.
  const before = t.status;
  if (before === status) return t;
  const allowed = ALLOWED_TRANSITIONS[before] ?? [];
  if (!allowed.includes(status)) {
    throw new Error(`Illegal status transition: ${before} -> ${status}`);
  }
  t.status = status;
  t.updatedAt = nowIso();
  if (status === 'triaged' && !t.triagedAt) t.triagedAt = nowIso();
  if (status === 'resolved') t.resolvedAt = nowIso();
  if (status === 'closed') t.closedAt = nowIso();

  const reopened = (before === 'resolved' || before === 'closed') && status === 'in_progress';
  addEvent(t.id, 'status_changed', actor, `${before} -> ${status}${note ? `: ${note}` : ''}`, { before, after: status });
  writeAudit({
    actorType: actor.type, actorId: actor.id,
    action: reopened ? 'ticket_reopened' : status === 'closed' ? 'ticket_closed' : 'ticket_status_changed',
    targetType: 'ticket', targetId: t.shortId,
    beforeState: { status: before }, afterState: { status }
  });
  save();
  return t;
}

export function assignTicket(actor: Actor, id: string, assigneeId: string, assigneeName?: string): Ticket {
  const t = getTicket(id);
  if (!t) throw new Error('Ticket not found');
  if (!canManageTicket(actor, t)) throw new Error('Not authorized to assign this ticket.');
  const before = t.assigneeId ?? null;
  t.assigneeId = assigneeId;
  t.assigneeName = assigneeName ?? assigneeId;
  t.updatedAt = nowIso();
  addEvent(t.id, 'assigned', actor, `Assigned to ${t.assigneeName}.`);
  writeAudit({
    actorType: actor.type, actorId: actor.id, action: 'ticket_assigned',
    targetType: 'ticket', targetId: t.shortId, beforeState: { assigneeId: before }, afterState: { assigneeId }
  });
  save();
  return t;
}

export function setPriority(actor: Actor, id: string, priority: Priority): Ticket {
  const t = getTicket(id);
  if (!t) throw new Error('Ticket not found');
  if (!canManageTicket(actor, t)) throw new Error('Not authorized.');
  const before = t.priority;
  t.priority = priority;
  t.updatedAt = nowIso();
  addEvent(t.id, 'priority_changed', actor, `${before} -> ${priority}`);
  writeAudit({ actorType: actor.type, actorId: actor.id, action: 'ticket_updated', targetType: 'ticket', targetId: t.shortId, beforeState: { priority: before }, afterState: { priority } });
  save();
  return t;
}

export function escalateTicket(actor: Actor, id: string, reason: string): Ticket {
  const t = getTicket(id);
  if (!t) throw new Error('Ticket not found');
  if (!canViewTicket(actor, t)) throw new Error('Not authorized.');
  const before = t.status;
  if (ALLOWED_TRANSITIONS[before]?.includes('waiting_on_admin')) {
    t.status = 'waiting_on_admin';
  }
  if (t.priority === 'low') t.priority = 'normal';
  else if (t.priority === 'normal') t.priority = 'high';
  t.updatedAt = nowIso();
  addEvent(t.id, 'escalated', actor, `Escalated: ${reason}`);
  writeAudit({ actorType: actor.type, actorId: actor.id, action: 'ticket_status_changed', targetType: 'ticket', targetId: t.shortId, beforeState: { status: before }, afterState: { status: t.status }, metadata: { escalated: true, reason } });
  save();
  return t;
}

export function addMessage(actor: Actor, id: string, body: string, internal = false): TicketMessage {
  const t = getTicket(id);
  if (!t) throw new Error('Ticket not found');
  if (internal && !canManageTicket(actor, t)) throw new Error('Only admins/managers can add internal notes.');
  if (!internal && !canViewTicket(actor, t)) throw new Error('Not authorized.');
  const msg: TicketMessage = {
    id: uuid(), ticketId: t.id, authorType: actor.type, authorId: actor.id,
    authorName: actor.displayName ?? actor.email, body, internal, createdAt: nowIso()
  };
  db().ticketMessages.push(msg);
  t.updatedAt = nowIso();
  if (internal) {
    writeAudit({ actorType: actor.type, actorId: actor.id, action: 'admin_note_added', targetType: 'ticket', targetId: t.shortId });
  } else if (actor.type === 'agent') {
    writeAudit({ actorType: 'agent', actorId: actor.id, action: 'ai_message_created', targetType: 'ticket', targetId: t.shortId });
  } else {
    writeAudit({ actorType: actor.type, actorId: actor.id, action: 'ticket_updated', targetType: 'ticket', targetId: t.shortId, metadata: { message: true } });
  }
  save();
  return msg;
}

export function getMessages(actor: Actor, id: string): TicketMessage[] {
  const t = getTicket(id);
  if (!t) return [];
  const canManage = canManageTicket(actor, t);
  return db().ticketMessages
    .filter((m) => m.ticketId === t.id)
    .filter((m) => canManage || !m.internal)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

export function getEvents(id: string): TicketEvent[] {
  const t = getTicket(id);
  if (!t) return [];
  return db().ticketEvents.filter((e) => e.ticketId === t.id).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

export function linkApproval(ticketId: string, approvalId: string) {
  const t = getTicket(ticketId);
  if (!t) return;
  if (!t.linkedApprovalIds.includes(approvalId)) t.linkedApprovalIds.push(approvalId);
  if (ALLOWED_TRANSITIONS[t.status]?.includes('approval_required')) t.status = 'approval_required';
  t.updatedAt = nowIso();
  save();
}

function addEvent(ticketId: string, type: string, actor: Actor, summary: string, data?: Record<string, unknown>) {
  const ev: TicketEvent = {
    id: uuid(), ticketId, type, actorType: actor.type, actorId: actor.id, summary, data, createdAt: nowIso()
  };
  db().ticketEvents.push(ev);
}
