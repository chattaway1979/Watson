// Admin-only support case detail.
import { getServerActor } from '@/lib/it-agent/session';
import { roleAtLeast } from '@/lib/it-agent/constants';
import { getCaseForActor } from '@/lib/it-agent';
import { toAdminView } from '@/lib/it-agent/watson/cases';
import { ok, fail } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const actor = getServerActor(req);
  if (!actor) return fail('Authentication required.', 401);
  if (!roleAtLeast(actor.role, 'admin')) return fail('Admin role required to view case details.', 403);
  const { caseId } = await params;
  const c = getCaseForActor(caseId, actor); // admin is permitted by getCaseForActor
  if (!c) return fail('Case not found.', 404);
  return ok(toAdminView(c), { headers: { 'Cache-Control': 'no-store' } });
}
