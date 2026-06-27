import { actorFromRequest } from '@/lib/it-agent/session';
import { listTicketsFor, listAllTickets, createTicket } from '@/lib/it-agent/tickets';
import { getAiProvider } from '@/lib/it-agent/ai-provider';
import { ensureSeeded } from '@/lib/it-agent/knowledge';
import { roleAtLeast } from '@/lib/it-agent/constants';
import { ok, fail } from '@/lib/http';
import type { TicketCategory, TicketStatus, Priority } from '@/lib/it-agent/types';

export async function GET(req: Request) {
  ensureSeeded();
  const actor = actorFromRequest(req);
  const url = new URL(req.url);
  const scope = url.searchParams.get('scope');
  const filter = {
    status: (url.searchParams.get('status') as TicketStatus) || undefined,
    category: (url.searchParams.get('category') as TicketCategory) || undefined,
    priority: (url.searchParams.get('priority') as Priority) || undefined
  };
  const rows = scope === 'all' && roleAtLeast(actor.role, 'admin')
    ? listAllTickets(filter)
    : listTicketsFor(actor, filter);
  return ok(rows);
}

export async function POST(req: Request) {
  ensureSeeded();
  const actor = actorFromRequest(req);
  const body = (await req.json().catch(() => ({}))) as {
    subject?: string; description?: string; category?: TicketCategory; priority?: Priority; runTriage?: boolean;
  };
  if (!body.description || !body.description.trim()) return fail('Description is required.', 400);

  let aiDiagnosis = null;
  let recommendedActions = undefined;
  let category = body.category;
  let priority = body.priority;

  if (body.runTriage !== false) {
    const ai = getAiProvider();
    const triage = await ai.triage(`${body.subject ?? ''} ${body.description}`);
    aiDiagnosis = triage.diagnosis;
    recommendedActions = triage.plan.recommendedActions;
    category = category ?? triage.diagnosis.category;
    priority = priority ?? triage.diagnosis.priority;
  }

  const ticket = createTicket(actor, {
    subject: body.subject ?? (body.description.slice(0, 60)),
    description: body.description,
    category: (category ?? 'other') as TicketCategory,
    priority,
    aiDiagnosis,
    recommendedActions
  });
  return ok(ticket);
}
