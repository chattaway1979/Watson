// Watson — 021B RBAC route. Narrow, single-purpose. Authenticates via the
// platform principal, delegates every decision to the security core, and
// returns structured safe errors. There is no generic mutation endpoint.
import { NextResponse } from 'next/server';
import { trustedIdentityFromHeaders, statusFor, messageFor, NO_STORE } from '@/lib/it-agent/rbac/http';
import { readEmployeeRoles } from '@/lib/it-agent/rbac/service';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  const actor = trustedIdentityFromHeaders(req.headers);
  const oid = new URL(req.url).searchParams.get('oid');
  const r = readEmployeeRoles(actor, oid);
  if (!r.ok) return NextResponse.json({ error: r.reason, ...messageFor(r.reason) }, { status: statusFor(r.reason), ...NO_STORE });
  return NextResponse.json(r.data, NO_STORE);
}
