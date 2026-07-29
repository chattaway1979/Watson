// Watson — 021B RBAC route. Narrow, single-purpose. Authenticates via the
// platform principal, delegates every decision to the security core, and
// returns structured safe errors. There is no generic mutation endpoint.
//
// 021D: the directory is now resolved before the search runs. With the live gate
// off it is the staged fixture list, honestly labelled. With the gate on it is a
// real read-only Microsoft Graph lookup via the managed identity — and if Graph
// cannot serve the request the route REFUSES rather than quietly substituting
// mock identities, because an administrator choosing who gets access must never
// be shown stand-in people as if they were real.
import { NextResponse } from 'next/server';
import { trustedIdentityFromHeaders, statusFor, messageFor, NO_STORE } from '@/lib/it-agent/rbac/http';
import { searchEmployees } from '@/lib/it-agent/rbac/service';
import type { DirectorySource } from '@/lib/it-agent/rbac/service';
import { STAGED_DIRECTORY_SOURCE } from '@/lib/it-agent/rbac/directory';
import { lookupEmployeesViaGraph } from '@/lib/it-agent/rbac/graph-directory';
import { isGraphLiveReadOnlyEnabled } from '@/lib/it-agent/graph/graph-config';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const actor = trustedIdentityFromHeaders(req.headers);
  const q = new URL(req.url).searchParams.get('q');

  // Gate off: the staged directory, which declares its own provenance. No token
  // is acquired and no Graph request is made.
  if (!isGraphLiveReadOnlyEnabled()) {
    const r = searchEmployees(actor, q, STAGED_DIRECTORY_SOURCE);
    if (!r.ok) return NextResponse.json({ error: r.reason, ...messageFor(r.reason) }, { status: statusFor(r.reason), ...NO_STORE });
    return NextResponse.json(r.data, NO_STORE);
  }

  // Gate on: authorize FIRST, so an unauthenticated or non-administrator caller
  // can never cause a tenant directory read.
  const gate = searchEmployees(actor, q, { provenance: 'graph_live', entries: [] });
  if (!gate.ok) {
    return NextResponse.json({ error: gate.reason, ...messageFor(gate.reason) }, { status: statusFor(gate.reason), ...NO_STORE });
  }

  const live = await lookupEmployeesViaGraph(q);
  if (!live.ok) {
    // Honest failure. `reason` is a fixed safe category; no Graph body, status
    // text, token or tenant detail is propagated.
    return NextResponse.json(
      { error: 'directory_unavailable', directoryReason: live.reason, ...messageFor('directory_unavailable') },
      { status: statusFor('directory_unavailable'), ...NO_STORE }
    );
  }

  const source: DirectorySource = live.source;
  const r = searchEmployees(actor, q, source);
  if (!r.ok) return NextResponse.json({ error: r.reason, ...messageFor(r.reason) }, { status: statusFor(r.reason), ...NO_STORE });
  return NextResponse.json(r.data, NO_STORE);
}
