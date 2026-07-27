// ============================================================
// Watson — H&R AI IT Agent : Read-only Microsoft 365 diagnostics API
// ------------------------------------------------------------
// GET /api/it-agent/diagnostics/m365?read=<action>&target=<email>
//
// A thin, admin-only HTTP surface over the existing server-side
// runM365Diagnostic caller. It performs NO diagnostic logic of its own:
//   * Identity + actor come from the existing session seam.
//   * Authorization is the existing policy (canPerformAction, invoked
//     inside runM365Diagnostic); the route's admin check is only a fast,
//     established 403 gate — it is NOT a second authorization system.
//   * Only the five existing read-only M365 actions are accepted, and only
//     an email/UPN target — never arbitrary Graph paths, OData, methods,
//     headers, bodies, tenant IDs, or connector config.
//   * The response is exactly the normalized M365DiagnosticOutcome. Raw Graph
//     payloads, tokens, secrets, headers, env, and stacks never leave here.
//   * The route wires NO live transport, so it is mock-by-default and can
//     never itself trigger a live Graph/Azure/Key Vault call.
// ============================================================
import { actorFromRequestOrNull } from '@/lib/it-agent/session';
import { roleAtLeast } from '@/lib/it-agent/constants';
import { runM365Diagnostic, bootstrapM365ReadOnlyConnector, type M365ReadKey } from '@/lib/it-agent';
import { ensureSeeded } from '@/lib/it-agent/knowledge';
import { ok, fail } from '@/lib/http';

// Route handlers that read identity must never be statically cached or shared
// across users.
export const dynamic = 'force-dynamic';

// The exact, closed set of read-only diagnostics this route exposes. Validating
// against this allowlist (not the whole action registry) prevents action-name
// injection toward non-read or write actions.
const SUPPORTED_READS: readonly M365ReadKey[] = [
  'lookup_user',
  'check_license_status',
  'check_mfa_status',
  'check_mailbox_status',
  'check_group_membership'
] as const;

const MAX_TARGET_LEN = 320; // RFC 5321 max email length
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } } as const;

export async function GET(req: Request) {
  try {
    // 1) Authentication: no identity signal => 401 (distinct from under-privileged).
    const actor = actorFromRequestOrNull(req);
    if (!actor) return fail('Authentication required.', 401);

    // 2) Authorization (established 403 gate). Policy remains authoritative inside
    //    runM365Diagnostic; this is a fast, conventional pre-check.
    if (!roleAtLeast(actor.role, 'admin')) {
      return fail('Admin role required for Microsoft 365 diagnostics.', 403);
    }

    // 3) Input contract: exactly one supported read + one email/UPN target.
    const url = new URL(req.url);
    const readParam = url.searchParams.get('read');
    const targetParam = (url.searchParams.get('target') ?? '').trim();

    if (!readParam || !SUPPORTED_READS.includes(readParam as M365ReadKey)) {
      return fail('Unsupported or missing "read". Allowed: ' + SUPPORTED_READS.join(', '), 400);
    }
    if (!targetParam) return fail('Missing "target".', 400);
    if (targetParam.length > MAX_TARGET_LEN) return fail('Target is too long.', 400);
    if (!EMAIL_SHAPE.test(targetParam)) return fail('Target must be a valid email / UPN.', 400);

    const read = readParam as M365ReadKey;
    ensureSeeded();

    // 4) Resolve the connector through the production bootstrap: mock by default,
    //    live_readonly only when the full gate + Azure Key Vault + transport are
    //    in place, else fail_closed. The bootstrap reads server env only — no
    //    caller-supplied config — and never constructs Azure clients in mock mode.
    const connector = await bootstrapM365ReadOnlyConnector();
    const outcome = await runM365Diagnostic(actor, read, targetParam, { connector });

    // 5) Map the normalized outcome to HTTP. `denied` (a defensive policy denial
    //    after the admin gate) becomes 403; evidence / not_configured return the
    //    normalized contract as-is. Nothing else is ever serialized.
    if (outcome.outcome === 'denied') {
      return fail('Not authorized for this diagnostic.', 403);
    }
    return ok(outcome, NO_STORE);
  } catch {
    // Never surface an internal error message or stack to the caller.
    return fail('Internal error processing the diagnostic.', 500);
  }
}
