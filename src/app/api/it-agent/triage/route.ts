import { actorFromRequest } from '@/lib/it-agent/session';
import { watsonRespond } from '@/lib/it-agent/deterministic-agent';
import { ensureSeeded } from '@/lib/it-agent/knowledge';
import { ok, fail } from '@/lib/http';

export async function POST(req: Request) {
  ensureSeeded();
  const actor = actorFromRequest(req);
  const body = (await req.json().catch(() => ({}))) as { text?: string };
  if (!body.text || !body.text.trim()) return fail('Please describe your IT issue.', 400);
  const reply = await watsonRespond(actor, body.text);
  return ok(reply);
}
