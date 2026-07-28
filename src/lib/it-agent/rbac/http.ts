// ============================================================
// Watson — 021B : RBAC HTTP boundary helpers (SERVER-ONLY)
// ------------------------------------------------------------
// Converts the platform-validated Easy Auth principal into the TrustedIdentity
// the security core expects. The browser cannot influence this: Easy Auth
// strips and replaces `x-ms-client-principal` on every inbound request, so a
// forged header never reaches us — and even if one did, the oid must still be
// a well-formed GUID or `resolveTrustedIdentity` refuses it.
//
// Nothing here re-implements authorization. It resolves identity and hands off
// to the service; every decision stays in one place.
// ============================================================
import { resolveTrustedIdentity, type TrustedIdentity, type RefusalReason } from './service';

export interface HeaderBag { get(name: string): string | null }

// Claim types Entra uses for the immutable object id.
const OID_CLAIMS = [
  'http://schemas.microsoft.com/identity/claims/objectidentifier',
  'oid'
];
const UPN_CLAIMS = [
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn',
  'preferred_username', 'upn',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'
];
const NAME_CLAIMS = [
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name', 'name'
];

interface PrincipalClaim { typ?: string; val?: string }
interface Principal { claims?: PrincipalClaim[] }

// Returns null when the platform did not supply a usable principal. Absence is
// an authentication failure, never a fallback to a header or cookie.
// ------------------------------------------------------------
// LOCAL TEST SEAM (021C Part 1).
//
// Easy Auth does not exist on a developer machine, so the administrator UI
// cannot be exercised in a browser without a principal. This seam supplies a
// SYNTHETIC one, and it is deliberately hard to turn on by accident:
//
//   * it is ignored entirely when NODE_ENV === 'production';
//   * it requires an explicit WATSON_LOCAL_TEST_OID env var — there is no
//     default, no first-user-wins, and no request input that can reach it;
//   * the value must still be a well-formed object id, so it cannot widen what
//     counts as an identity;
//   * a request header, cookie or query parameter can never trigger it.
//
// Tests assert it is inert in production. It exists so local browser validation
// does not require weakening the real authentication path.
// ------------------------------------------------------------
export function localTestIdentity(env: NodeJS.ProcessEnv = process.env): TrustedIdentity | null {
  if (env.NODE_ENV === 'production') return null;
  const oid = env.WATSON_LOCAL_TEST_OID?.trim();
  if (!oid) return null;
  return resolveTrustedIdentity({
    oid,
    upn: env.WATSON_LOCAL_TEST_UPN?.trim() || 'local.test@staged.invalid',
    displayName: env.WATSON_LOCAL_TEST_NAME?.trim() || 'Local Test Administrator'
  });
}

export function trustedIdentityFromHeaders(headers: HeaderBag): TrustedIdentity | null {
  const raw = headers.get('x-ms-client-principal');
  // The platform principal always wins. The local seam is only consulted when
  // the platform supplied nothing, and never in production.
  if (!raw) return localTestIdentity();
  let principal: Principal;
  try {
    principal = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as Principal;
  } catch {
    return null;
  }
  const claims = Array.isArray(principal.claims) ? principal.claims : [];
  const pick = (types: string[]) =>
    claims.find((c) => typeof c.typ === 'string' && types.includes(c.typ))?.val;
  return resolveTrustedIdentity({
    oid: pick(OID_CLAIMS),
    upn: pick(UPN_CLAIMS),
    displayName: pick(NAME_CLAIMS)
  });
}

// Map an internal refusal to an HTTP status. Deliberately coarse: the client
// learns it was refused and what to do next, never which internal check fired
// or whether the target exists.
export function statusFor(reason: RefusalReason): number {
  switch (reason) {
    case 'unauthenticated': return 401;
    case 'not_authorized':
    case 'self_elevation':
    case 'not_assignable':
    case 'not_removable':
    case 'last_admin_protected':
    case 'elevated_ack_required':
      return 403;
    case 'stale_preview':
    case 'replayed_preview':
    case 'actor_mismatch':
    case 'target_mismatch':
    case 'role_mismatch':
      return 409;
    case 'persistence_failure':
    case 'audit_failure':
      return 500;
    default:
      return 400;
  }
}

// Employee-safe explanation + next action. No stack traces, no database errors,
// no hints about which internal rule fired beyond what the administrator needs.
export function messageFor(reason: RefusalReason): { message: string; nextAction: string } {
  switch (reason) {
    case 'unauthenticated':
      return { message: 'You are not signed in.', nextAction: 'Sign in again and retry.' };
    case 'not_authorized':
      return { message: 'You do not have permission to administer Watson roles.', nextAction: 'Ask a Watson role administrator for access.' };
    case 'self_elevation':
      return { message: 'You cannot assign a role to yourself.', nextAction: 'Ask another role administrator to make this change.' };
    case 'last_admin_protected':
      return { message: 'This is the final Watson role administrator and cannot be removed.', nextAction: 'Assign another role administrator first.' };
    case 'elevated_ack_required':
      return { message: 'This change needs the elevated-risk acknowledgement.', nextAction: 'Tick the acknowledgement and confirm again.' };
    case 'stale_preview':
      return { message: 'This person’s roles changed since you opened the preview.', nextAction: 'Refresh the preview and review the change again.' };
    case 'replayed_preview':
      return { message: 'That confirmation was already used.', nextAction: 'Start a new preview if you still need the change.' };
    case 'actor_mismatch':
      return { message: 'This preview belongs to a different administrator.', nextAction: 'Create your own preview.' };
    case 'target_mismatch':
    case 'role_mismatch':
      return { message: 'The confirmation did not match the preview.', nextAction: 'Refresh and review the change again.' };
    case 'unknown_role':
      return { message: 'That is not a Watson role.', nextAction: 'Choose a role from the list.' };
    case 'invalid_target':
    case 'target_not_found':
      return { message: 'That employee could not be identified.', nextAction: 'Search again and select from the results.' };
    case 'persistence_failure':
      return { message: 'The change could not be saved, so nothing was changed.', nextAction: 'Retry shortly. If it persists, contact IT.' };
    case 'audit_failure':
      return { message: 'The change was rolled back because it could not be recorded.', nextAction: 'Retry shortly. If it persists, contact IT.' };
    case 'malformed_payload':
      return { message: 'That request was not valid.', nextAction: 'Refresh the page and try again.' };
    default:
      return { message: 'The request was refused.', nextAction: 'Refresh and try again.' };
  }
}

export const NO_STORE = { headers: { 'Cache-Control': 'no-store' } } as const;
