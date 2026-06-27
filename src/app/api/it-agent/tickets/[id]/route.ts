import { actorFromRequest } from '@/lib/it-agent/session';
import { getTicket, getMessages, getEvents, setStatus, assignTicket, setPriority, escalateTicket } from '@/lib/it-agent/tickets';
import { canViewTicket } from '@/lib/it-agent/policy';
import { listApprovals } from '@/lib/it-agent/approval-engine';
import { ok, fail } from '@/lib/http';
import type { Priority, TicketStatus } from '@/lib/it-agent/types';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = actorFromRequest(req);
  const ticket = getTicket(id);
  if (!ticket) return fail('Ticket not found', 404);
  if (!canViewTicket(actor, ticket)) return fail('Not authorized to view this ticket.', 403);
  const messages = getMessages(actor, ticket.id);
  const events = getEvents(ticket.id);
  const approvals = listApprovals().filter((a) => ticket.linkedApprovalIds.includes(a.id));
  return ok({ ticket, messages, events, approvals });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = actorFromRequest(req);
  const body = (await req.json().catch(() => ({}))) as {
    op?: string; status?: TicketStatus; priority?: Priority; assigneeId?: string; assigneeName?: string; reason?: string; note?: string;
  };
  try {
    let ticket;
    switch (body.op) {
      case 'status': ticket = setStatus(actor, id, body.status as TicketStatus, body.note); break;
      case 'assign': ticket = assignTicket(actor, id, body.assigneeId ?? actor.id, body.assigneeName); break;
      case 'priority': ticket = setPriority(actor, id, body.priority as Priority); break;
      case 'escalate': ticket = escalateTicket(actor, id, body.reason ?? 'Escalated by user.'); break;
      default: return fail('Unknown op. Use status|assign|priority|escalate.', 400);
    }
    return ok(ticket);
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed', 400);
  }
}