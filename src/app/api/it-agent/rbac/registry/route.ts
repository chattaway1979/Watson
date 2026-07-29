// Watson — 021B RBAC route. Narrow, single-purpose. Authenticates via the
// platform principal, delegates every decision to the security core, and
// returns structured safe errors. There is no generic mutation endpoint.
import { NextResponse } from 'next/server';
import { trustedIdentityFromHeaders, statusFor, messageFor, NO_STORE } from '@/lib/it-agent/rbac/http';
import { readRegistry } from '@/lib/it-agent/rbac/service';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  const actor = trustedIdentityFromHeaders(req.headers);
  const r = await readRegistry(actor);
  if (!r.ok) return NextResponse.json({ error: r.reason, ...messageFor(r.reason) }, { status: statusFor(r.reason), ...NO_STORE });
  return NextResponse.json({ roles: r.data }, NO_STORE);
}
