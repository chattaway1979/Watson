import { getServerActor } from '@/lib/it-agent/session';
import { listApprovals } from '@/lib/it-agent/approval-engine';
import { roleAtLeast } from '@/lib/it-agent/constants';
import { ok, fail } from '@/lib/http';
import type { ApprovalStatus } from '@/lib/it-agent/types';

export async function GET(req: Request) {
  const actor = getServerActor(req);
  if (!actor) return fail('Authentication required.', 401);
  if (!roleAtLeast(actor.role, 'admin')) return fail('Admin role required to view the approval queue.', 403);
  const url = new URL(req.url);
  const status = (url.searchParams.get('status') as ApprovalStatus) || undefined;
  return ok(listApprovals(status));
}
