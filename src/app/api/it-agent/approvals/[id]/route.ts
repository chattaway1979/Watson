import { actorFromRequest } from '@/lib/it-agent/session';
import { decideApproval, getApproval } from '@/lib/it-agent/approval-engine';
import { ok, fail } from '@/lib/http';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const a = getApproval(id);
  if (!a) return fail('Approval not found', 404);
  return ok(a);
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = actorFromRequest(req);
  const body = (await req.json().catch(() => ({}))) as { decision?: 'approved' | 'rejected'; note?: string };
  if (body.decision !== 'approved' && body.decision !== 'rejected') {
    return fail('decision must be "approved" or "rejected".', 400);
  }
  try {
    const result = decideApproval(actor, id, body.decision, body.note);
    return ok(result);
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed', 403);
  }
}