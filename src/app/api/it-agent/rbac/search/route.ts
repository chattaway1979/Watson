// Watson — 021B RBAC route. Narrow, single-purpose. Authenticates via the
// platform principal, delegates every decision to the security core, and
// returns structured safe errors. There is no generic mutation endpoint.
import { NextResponse } from 'next/server';
import { trustedIdentityFromHeaders, statusFor, messageFor, NO_STORE } from '@/lib/it-agent/rbac/http';
import { searchEmployees } from '@/lib/it-agent/rbac/service';
import { STAGED_DIRECTORY_SOURCE } from '@/lib/it-agent/rbac/directory';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  const actor = trustedIdentityFromHeaders(req.headers);
  const q = new URL(req.url).searchParams.get('q');
  // The directory declares its own provenance; the route cannot overstate it.
  const r = searchEmployees(actor, q, STAGED_DIRECTORY_SOURCE);
  if (!r.ok) return NextResponse.json({ error: r.reason, ...messageFor(r.reason) }, { status: statusFor(r.reason), ...NO_STORE });
  return NextResponse.json(r.data, NO_STORE);
}
