// ============================================================
// Watson — H&R AI IT Agent : Identity / Session seam
// ------------------------------------------------------------
// Two explicit, env-selected authentication modes (WATSON_AUTH_MODE):
//
//   demo  (default) — local development & automated tests only. Identity
//                     comes from the `watson_role` cookie / X-Watson-Role
//                     header "role switcher". NEVER trusted in production.
//
//   entra           — production. Identity comes ONLY from a platform-verified
//                     Microsoft Entra session injected by Azure App Service
//                     Authentication (Easy Auth) as the `x-ms-client-principal`
//                     header. Client-supplied role headers/cookies are ignored.
//                     Admin is granted only via a configured Entra group object
//                     id or app-role value. Any gap fails closed.
//
// There is NO silent cross-mode fallback: the mode is chosen explicitly and
// each mode resolves identity only from its own trusted source. Backend policy
// enforcement always depends on the Actor resolved here, never on the UI.
//
// NOTE (deployment): entra mode assumes the app is deployed behind a platform
// auth gate (App Service Authentication / equivalent) that authenticates every
// request and STRIPS any client-supplied x-ms-client-principal. See
// docs/PILOT_RUNBOOK.md. NextAuth/Auth.js can populate the same seam by mapping
// its verified session into the principal shape below.
// ============================================================
import type { Actor, Role } from './types';

export type WatsonAuthMode = 'demo' | 'entra';

// Minimal header accessor shared by Request.headers and Next's headers().
export interface HeaderSource {
  get(name: string): string | null | undefined;
}

export function watsonAuthMode(env: NodeJS.ProcessEnv = process.env): WatsonAuthMode {
  return (env.WATSON_AUTH_MODE ?? 'demo').toLowerCase() === 'entra' ? 'entra' : 'demo';
}

// ------------------------------------------------------------
// DEMO identities (dev/test only).
// ------------------------------------------------------------
const DEMO_IDENTITIES: Record<Role, Actor> = {
  employee: { id: 'demo-employee', type: 'user', role: 'employee', email: 'carlos.field@hrelectriccompany.com', displayName: 'Carlos Field (Employee)' },
  manager: { id: 'demo-manager', type: 'user', role: 'manager', email: 'mike.pm@hrelectriccompany.com', displayName: 'Mike Rivera (Manager)' },
  admin: { id: 'demo-admin', type: 'admin', role: 'admin', email: 'admin.it@hrelectriccompany.com', displayName: 'Watson Admin' },
  owner: { id: 'demo-owner', type: 'admin', role: 'owner', email: 'owner@hrelectriccompany.com', displayName: 'Company Owner' },
  agent: { id: 'watson', type: 'agent', role: 'agent', email: 'watson@hrelectriccompany.com', displayName: 'Watson Agent' },
  system: { id: 'system', type: 'system', role: 'system', email: 'system@hrelectriccompany.com', displayName: 'System' }
};

// A user may only ever assume these four roles via the demo switcher — never
// agent or system.
const VALID_ROLES: Role[] = ['employee', 'manager', 'admin', 'owner'];

export function actorForRole(role: string | undefined | null): Actor {
  const r = (role ?? 'employee').toLowerCase() as Role;
  if (VALID_ROLES.includes(r)) return DEMO_IDENTITIES[r];
  return DEMO_IDENTITIES.employee;
}

function demoActorOrNull(h: HeaderSource): Actor | null {
  const header = h.get('x-watson-role');
  if (header) return actorForRole(header);
  const cookie = h.get('cookie') ?? '';
  const m = cookie.match(/(?:^|;\s*)watson_role=([^;]+)/);
  if (m?.[1]) return actorForRole(m[1]);
  return null;
}

// ------------------------------------------------------------
// ENTRA identity — parsed ONLY from the platform-verified principal.
// The mapping is CLOSED: it can yield exactly `admin` (when the configured
// admin group/app-role claim is present) or `employee` (otherwise). It can
// NEVER yield agent, system, or owner — end users cannot assume those.
// ------------------------------------------------------------
interface EasyAuthClaim { typ?: string; val?: string }
interface EasyAuthPrincipal { auth_typ?: string; claims?: EasyAuthClaim[] }

const EMAIL_CLAIM_TYPES = [
  'preferred_username',
  'email',
  'upn',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'
];
const OID_CLAIM_TYPES = ['http://schemas.microsoft.com/identity/claims/objectidentifier', 'oid'];
const NAME_CLAIM_TYPES = ['name', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'];

function claimValues(claims: EasyAuthClaim[], types: string[]): string[] {
  return claims.filter((c) => c.typ && types.includes(c.typ) && typeof c.val === 'string').map((c) => c.val as string);
}
function firstClaim(claims: EasyAuthClaim[], types: string[]): string | undefined {
  return claimValues(claims, types)[0];
}

// Admin is granted only when the principal carries the configured group object
// id (claim `groups`) OR the configured app role (claim `roles`). If neither
// selector is configured, NO ONE is admin (fail closed).
function principalIsAdmin(claims: EasyAuthClaim[], env: NodeJS.ProcessEnv): boolean {
  const adminGroup = env.WATSON_ADMIN_ENTRA_GROUP_ID?.trim();
  const adminRole = env.WATSON_ADMIN_APP_ROLE?.trim();
  if (!adminGroup && !adminRole) return false;
  if (adminGroup && claimValues(claims, ['groups']).includes(adminGroup)) return true;
  if (adminRole && claimValues(claims, ['roles']).includes(adminRole)) return true;
  return false;
}

export function actorFromEntra(h: HeaderSource, env: NodeJS.ProcessEnv = process.env): Actor | null {
  const raw = h.get('x-ms-client-principal');
  if (!raw) return null; // no verified session => unauthenticated
  let principal: EasyAuthPrincipal;
  try {
    principal = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as EasyAuthPrincipal;
  } catch {
    return null; // malformed principal => fail closed
  }
  const claims = Array.isArray(principal?.claims) ? principal.claims : [];
  const email = firstClaim(claims, EMAIL_CLAIM_TYPES);
  if (!email) return null; // cannot identify => fail closed
  const isAdmin = principalIsAdmin(claims, env);
  const oid = firstClaim(claims, OID_CLAIM_TYPES) ?? email;
  return {
    id: 'entra:' + oid,
    type: isAdmin ? 'admin' : 'user',
    role: isAdmin ? 'admin' : 'employee',
    email,
    displayName: firstClaim(claims, NAME_CLAIM_TYPES) ?? email
  };
}

// ------------------------------------------------------------
// Public, MODE-AWARE resolvers. In entra mode these read ONLY the verified
// principal and never trust x-watson-role / watson_role.
// ------------------------------------------------------------

// Nullable resolver — returns null when no trusted identity is present. Use for
// routes that must return 401 for unauthenticated callers.
export function actorFromRequestOrNull(req: { headers: HeaderSource }, env: NodeJS.ProcessEnv = process.env): Actor | null {
  return watsonAuthMode(env) === 'entra' ? actorFromEntra(req.headers, env) : demoActorOrNull(req.headers);
}
// Canonical name for new server code.
export const getServerActor = actorFromRequestOrNull;

// Non-null resolver kept for existing routes. In demo mode, absent identity
// defaults to the least-privileged employee (existing behavior). In entra mode,
// absent/invalid identity yields a locked anonymous actor that fails every
// authorization check — it is NEVER an employee/admin by default.
const ANONYMOUS: Actor = { id: 'anonymous', type: 'user', role: 'employee', displayName: 'Anonymous' };
export function actorFromRequest(req: { headers: HeaderSource }, env: NodeJS.ProcessEnv = process.env): Actor {
  if (watsonAuthMode(env) === 'entra') {
    return actorFromEntra(req.headers, env) ?? { ...ANONYMOUS, id: 'anonymous' };
  }
  return demoActorOrNull(req.headers) ?? DEMO_IDENTITIES.employee;
}

// Demo identities are only meaningful in demo mode; hidden in entra mode.
export function demoIdentities() {
  if (watsonAuthMode() === 'entra') return [];
  return VALID_ROLES.map((r) => ({ ...DEMO_IDENTITIES[r], role: r }));
}
