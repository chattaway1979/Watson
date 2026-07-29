// Watson — 021B RBAC route. Narrow, single-purpose. Authenticates via the
// platform principal, delegates every decision to the security core, and
// returns structured safe errors. There is no generic mutation endpoint.
import { NextResponse } from 'next/server';
import { trustedIdentityFromHeaders, statusFor, messageFor, NO_STORE } from '@/lib/it-agent/rbac/http';
import { readAuditHistory } from '@/lib/it-agent/rbac/service';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  const actor = trustedIdentityFromHeaders(req.headers);
  const u = new URL(req.url);
  const target = u.searchParams.get('oid') ?? undefined;
  const limit = Math.min(Number(u.searchParams.get('limit') ?? 100) || 100, 200);
  const r = await readAuditHistory(actor, target, limit);
  if (!r.ok) return NextResponse.json({ error: r.reason, ...messageFor(r.reason) }, { status: statusFor(r.reason), ...NO_STORE });
  return NextResponse.json({ events: r.data }, NO_STORE);
}
