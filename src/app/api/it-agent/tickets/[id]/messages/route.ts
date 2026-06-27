import { actorFromRequest } from '@/lib/it-agent/session';
import { getMessages, addMessage } from '@/lib/it-agent/tickets';
import { ok, fail } from '@/lib/http';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = actorFromRequest(req);
  return ok(getMessages(actor, id));
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = actorFromRequest(req);
  const body = (await req.json().catch(() => ({}))) as { body?: string; internal?: boolean };
  if (!body.body || !body.body.trim()) return fail('Message body required.', 400);
  try {
    const msg = addMessage(actor, id, body.body, Boolean(body.internal));
    return ok(msg);
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed', 403);
  }
}