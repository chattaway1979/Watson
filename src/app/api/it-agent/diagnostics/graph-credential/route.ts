// ============================================================
// Watson — WATSON-MANAGED-IDENTITY-GRAPH-LIVE-PILOT-011C
// GET /api/it-agent/diagnostics/graph-credential   (ADMIN ONLY)
// ------------------------------------------------------------
// Verifies the LIVE managed-identity Graph credential from inside the deployed
// App Service runtime. This is the only way to prove the platform identity can
// actually mint a Graph token, since a managed identity exists only in Azure.
//
// It makes NO Microsoft Graph DATA call. It talks solely to the Entra token
// service via ManagedIdentityCredential, then inspects the resulting token's own
// claims. No /users, /me, /groups, mailbox, device, or workload request occurs,
// so it reads no employee data whatsoever and is safe to run while the live-read
// gate is OFF — which is precisely when you need it.
//
// THE TOKEN NEVER LEAVES THIS FUNCTION. Only derived booleans and Graph role
// NAMES are returned. The audience is reported as a boolean, not a string, so no
// tenant-specific value can escape. Nothing is logged, audited, or persisted.
// ============================================================
import { actorFromRequestOrNull } from '@/lib/it-agent/session';
import { roleAtLeast, isLiveExternalExecutionEnabled } from '@/lib/it-agent/constants';
import {
  createManagedIdentityTokenProvider,
  inspectAccessTokenClaims,
  validateGraphRolePosture,
  effectiveGraphCapabilities,
  graphClientSecretPosture,
  isGraphLiveGateEnabled,
  REQUIRED_GRAPH_APP_ROLES
} from '@/lib/it-agent/graph/graph-managed-identity';
import { ok, fail } from '@/lib/http';

export const dynamic = 'force-dynamic';
const NO_STORE = { headers: { 'Cache-Control': 'no-store' } } as const;

export async function GET(req: Request) {
  try {
    const actor = actorFromRequestOrNull(req);
    if (!actor) return fail('Authentication required.', 401);
    if (!roleAtLeast(actor.role, 'admin')) {
      return fail('Admin role required for credential diagnostics.', 403);
    }

    const gateEnabled = isGraphLiveGateEnabled();
    const secretPosture = graphClientSecretPosture();

    // Production provider: ManagedIdentityCredential only. There is no CLI,
    // environment, developer, secret, or certificate fallback anywhere in it.
    const provider = createManagedIdentityTokenProvider();
    const token = await provider.getToken();

    if (!token) {
      // Fail closed and say so plainly — never imply a usable credential.
      return ok({
        credentialModel: 'managed_identity',
        state: 'managed_identity_unavailable',
        tokenAcquired: false,
        approvedRoles: [...REQUIRED_GRAPH_APP_ROLES],
        clientSecretPostureOk: secretPosture.ok,
        liveReadGateEnabled: gateEnabled,
        liveExecutionEnabled: isLiveExternalExecutionEnabled()
      }, NO_STORE);
    }

    // Derived, non-secret facts only. `token` is not referenced again.
    const claims = inspectAccessTokenClaims(token);
    const posture = validateGraphRolePosture(claims.roles);
    const capabilities = effectiveGraphCapabilities(claims.roles);

    return ok({
      credentialModel: 'managed_identity',
      state: posture.ok ? 'credential_ready' : 'graph_permission_incomplete',
      tokenAcquired: true,
      // Token shape validation — booleans only, no audience string, no subject.
      audienceIsGraph: claims.audienceIsGraph,
      applicationOnly: claims.applicationOnly,
      hasDelegatedScopes: claims.hasDelegatedScopes,
      expiresAtPresent: claims.expiresAtPresent,
      // Graph application role names are not sensitive and are the whole point.
      roles: [...claims.roles].sort(),
      approvedRoles: [...REQUIRED_GRAPH_APP_ROLES],
      posture,
      // Effective capability, derived from the roles actually present — not from
      // what we intended to grant.
      capabilities,
      clientSecretPostureOk: secretPosture.ok,
      liveReadGateEnabled: gateEnabled,
      liveExecutionEnabled: isLiveExternalExecutionEnabled()
    }, NO_STORE);
  } catch {
    return fail('Internal error verifying the Graph credential.', 500);
  }
}
