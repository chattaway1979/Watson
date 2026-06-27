import { actorFromRequest } from '@/lib/it-agent/session';
import { listAudit } from '@/lib/it-agent/audit';
import { roleAtLeast } from '@/lib/it-agent/constants';
import { ok, fail } from '@/lib/http';
import type { AuditEventType } from '@/lib/it-agent/types';

export async function GET(req: Request) {
  const actor = actorFromRequest(req);
  if (!roleAtLeast(actor.role, 'admin')) return fail('Admin role required to view audit logs.', 403);
  const url = new URL(req.url);
  const action = (url.searchParams.get('action') as AuditEventType) || undefined;
  const targetType = url.searchParams.get('targetType') || undefined;
  const targetId = url.searchParams.get('targetId') || undefined;
  const limit = Number(url.searchParams.get('limit') ?? '200');
  return ok(listAudit({ action, targetType, targetId, limit }));
}
