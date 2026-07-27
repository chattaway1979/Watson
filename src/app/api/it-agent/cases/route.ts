// Admin-only support case queue.
import { getServerActor } from '@/lib/it-agent/session';
import { roleAtLeast } from '@/lib/it-agent/constants';
import { listAllCases } from '@/lib/it-agent';
import { toQueueRow } from '@/lib/it-agent/watson/cases';
import { ok, fail } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const actor = getServerActor(req);
  if (!actor) return fail('Authentication required.', 401);
  if (!roleAtLeast(actor.role, 'admin')) return fail('Admin role required to view the support queue.', 403);
  return ok(listAllCases().map(toQueueRow), { headers: { 'Cache-Control': 'no-store' } });
}
