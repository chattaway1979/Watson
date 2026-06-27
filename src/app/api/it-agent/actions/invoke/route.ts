import { actorFromRequest } from '@/lib/it-agent/session';
import { invokeAction } from '@/lib/it-agent/tool-gateway';
import { ensureSeeded } from '@/lib/it-agent/knowledge';
import { ok, fail } from '@/lib/http';

export async function POST(req: Request) {
  ensureSeeded();
  const actor = actorFromRequest(req);
  const body = (await req.json().catch(() => ({}))) as { actionKey?: string; input?: Record<string, unknown>; ticketId?: string };
  if (!body.actionKey) return fail('actionKey is required.', 400);
  const outcome = invokeAction(actor, { actionKey: body.actionKey, input: body.input ?? {}, ticketId: body.ticketId ?? null });
  return ok(outcome);
}
