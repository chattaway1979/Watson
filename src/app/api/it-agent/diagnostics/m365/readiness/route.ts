// ============================================================
// Watson — H&R AI IT Agent : M365 live-read readiness API
// ------------------------------------------------------------
// GET /api/it-agent/diagnostics/m365/readiness
//
// Admin-only, no-store deployment diagnostics. Surfaces the value-free
// m365LiveReadiness view (auth mode, gate state, config presence booleans,
// connector readiness enum, safe reason codes). It constructs NO Azure client
// and makes NO Graph/Key Vault call — mock mode stays inert. It NEVER returns
// tenant/client ids, secret refs, vault URLs, managed-identity ids, tokens,
// secrets, claims, headers, or raw exceptions.
// ============================================================
import { getServerActor } from '@/lib/it-agent/session';
import { roleAtLeast } from '@/lib/it-agent/constants';
import { m365LiveReadiness } from '@/lib/it-agent/deployment';
import { ok, fail } from '@/lib/http';

export const dynamic = 'force-dynamic';
const NO_STORE = { headers: { 'Cache-Control': 'no-store' } } as const;

export async function GET(req: Request) {
  try {
    const actor = getServerActor(req);
    if (!actor) return fail('Authentication required.', 401);
    if (!roleAtLeast(actor.role, 'admin')) return fail('Admin role required for readiness diagnostics.', 403);
    return ok(m365LiveReadiness(process.env), NO_STORE);
  } catch {
    return fail('Internal error computing readiness.', 500);
  }
}
