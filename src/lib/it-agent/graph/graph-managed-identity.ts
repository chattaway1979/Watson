// ============================================================
// Watson — WATSON-MANAGED-IDENTITY-GRAPH-READINESS-011B (SERVER-ONLY)
// ------------------------------------------------------------
// Microsoft Graph credential path backed by the App Service SYSTEM-ASSIGNED
// MANAGED IDENTITY. This replaces the client-credentials design: there is no
// client secret, no certificate, no Key Vault dependency, and deliberately NO
// fallback credential of any kind.
//
// Invariants:
//   * ManagedIdentityCredential ONLY. DefaultAzureCredential is never used here,
//     so a developer/environment credential can never silently stand in for the
//     platform identity (the failure mode this module exists to prevent).
//   * No credential material is read from configuration, and none is emitted.
//   * The access token is never returned to a caller, logged, audited,
//     serialized, or persisted. Only derived, non-sensitive facts escape.
//   * Every abnormal condition fails CLOSED with a safe state code.
//   * Nothing here calls a Graph DATA endpoint. Token acquisition talks to the
//     Entra token service only; role posture is read from the token's own
//     claims, so no /users, /me, /groups, or workload call is ever made.
// ============================================================
import type { GraphConfig, GraphHttpClient } from './graph-config';
import { resolveGraphUrl, parseRetryAfterSeconds, GRAPH_REQUEST_TIMEOUT_MS } from './graph-config';

// The Graph resource. `.default` yields exactly the application permissions
// already admin-consented to the managed identity — never a broader set.
export const GRAPH_DEFAULT_SCOPE = 'https://graph.microsoft.com/.default';

// The approved minimum set for the first live pilot.
//
// GroupMember.Read.All is deliberately ABSENT (011B): Microsoft documents
// User.Read.All as the LEAST PRIVILEGED application permission for
// GET /users/{id}/transitiveMemberOf, listing GroupMember.Read.All only as a
// higher-privileged alternative.
//
// MailboxSettings.Read is deliberately ABSENT (011C, Exchange Option C): it was
// removed from the managed identity rather than left granted tenant-wide, so the
// first pilot carries no mailbox exposure at all. `check_mailbox_status` is
// therefore UNAVAILABLE by design — see GRAPH_READ_REQUIREMENTS below, which is
// what makes readiness report the EFFECTIVE permission rather than the intended
// one. See docs/GRAPH_MANAGED_IDENTITY_011B.md and docs/EXCHANGE_MAILBOX_SCOPING_011B.md.
export const REQUIRED_GRAPH_APP_ROLES = [
  'User.Read.All',
  'UserAuthenticationMethod.Read.All'
] as const;

// Which application role each Watson read actually needs. Capability is derived
// from the roles the token really carries, so a read whose permission has been
// removed is reported UNAVAILABLE instead of failing at call time.
export const GRAPH_READ_REQUIREMENTS: Record<string, readonly string[]> = {
  lookup_user: ['User.Read.All'],
  check_license_status: ['User.Read.All'],
  check_mfa_status: ['UserAuthenticationMethod.Read.All'],
  check_mailbox_status: ['MailboxSettings.Read'],
  // Authorized by User.Read.All per Microsoft's least-privilege table.
  check_group_membership: ['User.Read.All']
} as const;

export interface GraphCapabilities {
  available: string[];
  unavailable: string[];
}

// Effective capability from the roles actually present on the credential.
export function effectiveGraphCapabilities(roles: readonly string[]): GraphCapabilities {
  const granted = new Set(roles.map((r) => r.trim()).filter(Boolean));
  const available: string[] = [];
  const unavailable: string[] = [];
  for (const [read, needed] of Object.entries(GRAPH_READ_REQUIREMENTS)) {
    (needed.every((n) => granted.has(n)) ? available : unavailable).push(read);
  }
  return { available: available.sort(), unavailable: unavailable.sort() };
}

// Roles that must never appear on this identity. Matched case-insensitively
// against the token's `roles` claim.
const FORBIDDEN_ROLE_PATTERNS: readonly RegExp[] = [
  /ReadWrite/i,          // any write permission
  /\.Write/i,
  /^Directory\.Read\.All$/i,
  /^RoleManagement/i,    // privilege escalation
  /^DeviceManagement/i,  // wipe / retire / lock
  /\.Send$/i,
  /FullAccess/i
];

// ------------------------------------------------------------
// Credential state. These five states are distinguishable by design so an
// operator can tell "not switched on" from "switched on but broken".
// ------------------------------------------------------------
export type GraphCredentialState =
  | 'live_gate_disabled'           // gate off — connector inactive (the default)
  | 'managed_identity_unavailable' // no platform identity to acquire a token with
  | 'token_unavailable'            // identity present, token acquisition failed
  | 'graph_permission_incomplete'  // token acquired, required app roles missing
  | 'credential_ready';            // token acquired and role posture satisfied

export interface GraphRolePosture {
  ok: boolean;
  missing: string[];    // required roles absent from the token
  unexpected: string[]; // roles present beyond the approved minimum
  forbidden: string[];  // unexpected roles that are write/escalation-capable
}

export interface GraphCredentialEvaluation {
  state: GraphCredentialState;
  // Present only once a token was actually acquired. Never includes the token.
  posture?: GraphRolePosture;
  // True only when the credential is usable AND the live gate is on.
  liveReadWouldAttempt: boolean;
}

// ------------------------------------------------------------
// Token provider seam. Tests inject a fake; production uses managed identity.
// getToken() returns null (never throws) on every failure so callers fail closed.
// ------------------------------------------------------------
export interface GraphTokenProvider {
  readonly id: string;
  getToken(): Promise<string | null>;
}

// Default provider: acquires nothing, contacts nothing. Without an explicitly
// constructed managed-identity provider the Graph path cannot initialize.
export const failClosedGraphTokenProvider: GraphTokenProvider = {
  id: 'fail-closed',
  async getToken(): Promise<string | null> {
    return null;
  }
};

// Optional user-assigned identity selector. Unset => system-assigned, which is
// what Watson uses. This is NOT a secret and NOT an app client id.
function managedIdentityClientId(env: NodeJS.ProcessEnv): string | undefined {
  const id = env.AZURE_MANAGED_IDENTITY_CLIENT_ID?.trim();
  return id ? id : undefined;
}

// Production token provider. The Azure SDK is imported LAZILY so it is never
// loaded during tests, build, or mock mode.
//
// ManagedIdentityCredential is used deliberately in place of
// DefaultAzureCredential: DefaultAzureCredential would fall back to Azure CLI /
// environment / developer credentials when no managed identity is present,
// which would let a developer identity impersonate the service. Restricting the
// chain to the platform identity makes that structurally impossible.
export function createManagedIdentityTokenProvider(
  env: NodeJS.ProcessEnv = process.env
): GraphTokenProvider {
  return {
    id: 'azure-managed-identity',
    async getToken(): Promise<string | null> {
      try {
        const { ManagedIdentityCredential } = await import('@azure/identity');
        const clientId = managedIdentityClientId(env);
        const credential = new ManagedIdentityCredential(clientId ? { clientId } : undefined);
        const token = await credential.getToken(GRAPH_DEFAULT_SCOPE);
        const value = token?.token;
        if (typeof value !== 'string' || value.length === 0) return null;
        return value;
      } catch {
        // No identity endpoint, IMDS unreachable, permission denied, SDK failure.
        // The underlying error is intentionally NOT surfaced — it can echo
        // environment detail. Fail closed.
        return null;
      }
    }
  };
}

// ------------------------------------------------------------
// Role posture, derived from the access token's own `roles` claim.
// ------------------------------------------------------------

// Extract ONLY the `roles` claim from a JWT access token. The signature is not
// verified because this is not an authorization decision — Graph itself is
// authoritative. It is a local posture check, so a malformed or unreadable token
// simply yields no roles (fail closed).
//
// Nothing but the role strings escapes this function: the token, its subject,
// tenant, expiry, and every other claim are discarded.
export function extractGraphRoles(accessToken: string | null | undefined): string[] {
  if (typeof accessToken !== 'string') return [];
  const parts = accessToken.split('.');
  if (parts.length < 2) return [];
  try {
    const payload = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const parsed = JSON.parse(payload) as { roles?: unknown };
    if (!Array.isArray(parsed.roles)) return [];
    return parsed.roles.filter((r): r is string => typeof r === 'string' && r.length > 0);
  } catch {
    return [];
  }
}

// Non-secret validation view of an access token, for the live credential check.
//
// SAFETY: this returns ONLY derived booleans and role NAMES. The token, its
// subject, tenant, object id, app id, issuer, and every other claim are
// discarded and never returned, logged, or serialized. `audienceIsGraph` is a
// boolean rather than the audience string so no tenant-specific value escapes.
export interface AccessTokenValidation {
  audienceIsGraph: boolean;
  applicationOnly: boolean;     // app-only (roles), not delegated (scp)
  hasDelegatedScopes: boolean;  // must be false for an app-only credential
  roles: string[];
  expiresAtPresent: boolean;    // structural sanity only; no timestamp emitted
}

const GRAPH_AUDIENCES = new Set([
  'https://graph.microsoft.com',
  'https://graph.microsoft.com/',
  '00000003-0000-0000-c000-000000000000'
]);

export function inspectAccessTokenClaims(accessToken: string | null | undefined): AccessTokenValidation {
  const empty: AccessTokenValidation = {
    audienceIsGraph: false, applicationOnly: false, hasDelegatedScopes: false,
    roles: [], expiresAtPresent: false
  };
  if (typeof accessToken !== 'string') return empty;
  const parts = accessToken.split('.');
  if (parts.length < 2) return empty;
  try {
    const payload = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const c = JSON.parse(payload) as { aud?: unknown; scp?: unknown; roles?: unknown; exp?: unknown; idtyp?: unknown };
    const roles = Array.isArray(c.roles) ? c.roles.filter((r): r is string => typeof r === 'string' && r.length > 0) : [];
    // A delegated token carries `scp`. Its presence means this is NOT app-only.
    const hasDelegatedScopes = typeof c.scp === 'string' && c.scp.trim().length > 0;
    return {
      audienceIsGraph: typeof c.aud === 'string' && GRAPH_AUDIENCES.has(c.aud.trim()),
      applicationOnly: !hasDelegatedScopes && (c.idtyp === 'app' || roles.length > 0),
      hasDelegatedScopes,
      roles,
      expiresAtPresent: typeof c.exp === 'number'
    };
  } catch {
    return empty;
  }
}

// Compare granted roles against the approved minimum. Pure; no network.
export function validateGraphRolePosture(roles: readonly string[]): GraphRolePosture {
  const granted = new Set(roles.map((r) => r.trim()).filter(Boolean));
  const missing = REQUIRED_GRAPH_APP_ROLES.filter((r) => !granted.has(r));
  const required = new Set<string>(REQUIRED_GRAPH_APP_ROLES);
  const unexpected = [...granted].filter((r) => !required.has(r));
  const forbidden = unexpected.filter((r) => FORBIDDEN_ROLE_PATTERNS.some((p) => p.test(r)));
  return { ok: missing.length === 0 && forbidden.length === 0, missing, unexpected, forbidden };
}

// ------------------------------------------------------------
// Client-secret posture. Under the managed-identity model any Graph client
// secret is an unexpected credential and a posture FAILURE, not a fallback.
// ------------------------------------------------------------
export function graphClientSecretPosture(env: NodeJS.ProcessEnv = process.env): {
  ok: boolean;
  offendingKeys: string[];
} {
  // A secret VALUE in configuration is a violation. A Key Vault REFERENCE name
  // is legacy 011A configuration: inert under this model, reported so it can be
  // cleaned up, but not treated as a credential.
  const offendingKeys = ['GRAPH_CLIENT_SECRET', 'AZURE_CLIENT_SECRET']
    .filter((k) => Boolean(env[k]?.trim()));
  return { ok: offendingKeys.length === 0, offendingKeys };
}

export function isGraphLiveGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.IT_AGENT_GRAPH_LIVE_READONLY ?? 'false').toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

// ------------------------------------------------------------
// Readiness evaluation — the five distinguishable states.
//
// `probe: false` (default) evaluates STRUCTURALLY and acquires no token, so it
// is safe to call anywhere, including while the live gate is off. Only an
// explicit `probe: true` attempts token acquisition.
// ------------------------------------------------------------
export async function evaluateGraphCredential(opts: {
  env?: NodeJS.ProcessEnv;
  tokenProvider?: GraphTokenProvider;
  probe?: boolean;
} = {}): Promise<GraphCredentialEvaluation> {
  const env = opts.env ?? process.env;
  const gateOn = isGraphLiveGateEnabled(env);

  // Gate off is reported first and unconditionally: the connector is inactive
  // regardless of credential health, and no token is acquired.
  if (!gateOn) return { state: 'live_gate_disabled', liveReadWouldAttempt: false };

  if (!opts.probe) {
    // Gate on but no probe requested: we cannot claim readiness we have not
    // demonstrated, so report the credential as unavailable (fail closed).
    return { state: 'managed_identity_unavailable', liveReadWouldAttempt: false };
  }

  const provider = opts.tokenProvider ?? failClosedGraphTokenProvider;
  const token = await provider.getToken();
  if (!token) {
    // Distinguish "no identity to try with" from "identity tried and failed".
    const state: GraphCredentialState =
      provider.id === 'fail-closed' ? 'managed_identity_unavailable' : 'token_unavailable';
    return { state, liveReadWouldAttempt: false };
  }

  const posture = validateGraphRolePosture(extractGraphRoles(token));
  if (!posture.ok) {
    return { state: 'graph_permission_incomplete', posture, liveReadWouldAttempt: false };
  }
  return { state: 'credential_ready', posture, liveReadWouldAttempt: true };
}

// ------------------------------------------------------------
// Graph transport backed by the managed identity. Same read-only contract as
// the client-credentials transport; GET only, no write verb exists.
// ------------------------------------------------------------
export function createManagedIdentityGraphHttpClient(
  config: GraphConfig,
  tokenProvider: GraphTokenProvider
): GraphHttpClient {
  async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GRAPH_REQUEST_TIMEOUT_MS);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    async getToken(): Promise<string> {
      const token = await tokenProvider.getToken();
      // No secret fallback exists. If the platform identity cannot mint a token
      // the request fails; it never degrades to another credential.
      if (!token) throw new Error('Managed identity token unavailable.');
      return token;
    },
    async get(path: string, token: string): Promise<{ status: number; body: unknown; retryAfterSeconds?: number }> {
      // Throws if `path` targets any host other than the configured Graph origin,
      // so the bearer token is only ever attached to a genuine Graph request.
      const url = resolveGraphUrl(path, config.graphBaseUrl);
      const res = await fetchWithTimeout(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
      let body: unknown = null;
      try { body = await res.json(); } catch { body = null; }
      return { status: res.status, body, retryAfterSeconds: parseRetryAfterSeconds(res.headers.get('retry-after')) };
    }
  };
}

// Safe deployment-diagnostics view for the managed-identity model. Presence and
// state only — never a token, tenant, principal, or configuration value.
export function graphManagedIdentityReadiness(env: NodeJS.ProcessEnv = process.env) {
  const secretPosture = graphClientSecretPosture(env);
  return {
    credentialModel: 'managed_identity' as const,
    liveReadOnlyFlag: isGraphLiveGateEnabled(env),
    // Key Vault is NOT part of the Graph credential path under this model.
    keyVaultRequiredForGraph: false,
    // A user-assigned selector is optional; unset means system-assigned.
    userAssignedIdentitySelected: Boolean(env.AZURE_MANAGED_IDENTITY_CLIENT_ID?.trim()),
    clientSecretPostureOk: secretPosture.ok,
    unexpectedCredentialKeys: secretPosture.offendingKeys,
    requiredAppRoles: [...REQUIRED_GRAPH_APP_ROLES]
  };
}
