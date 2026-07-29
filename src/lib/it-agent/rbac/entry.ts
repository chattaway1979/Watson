// ============================================================
// Watson — 021C-1A : single RBAC request entry point (SERVER-ONLY)
// ------------------------------------------------------------
// The Access and Roles page and the RBAC API routes must reach the SAME role
// state through the SAME sequence. Previously the page inlined its own
// bootstrap -> identity -> capability sequence, so "does the page agree with the
// API?" was answered by reading two files and hoping. This module is the one
// place that sequence exists, which makes it directly testable.
//
// Order matters and is asserted by tests:
//   1. ensureBootstrap()  — configuration-only, idempotent, no request input
//   2. resolve identity   — platform principal, or the production-inert local seam
//   3. capability check   — against CURRENT durable role state
//
// Nothing here reads a cookie, query string or request body.
// ============================================================
import { trustedIdentityFromHeaders, type HeaderBag } from './http';
import { actorHasCapability, currentRoles, ensureBootstrap, type TrustedIdentity } from './service';
import type { Capability, WatsonRoleKey } from './roles';

export interface RbacEntryResult {
  actor: TrustedIdentity | null;
  authorized: boolean;
  roles: WatsonRoleKey[];
}

// Used by the page for its render decision. It is NOT the security boundary —
// every API route is refused independently by the security core — but it must
// agree with that boundary, which is why both start from bootstrap.
export async function authorizeRbacEntry(
  headers: HeaderBag,
  capability: Capability = 'rbac.registry.read',
  env: NodeJS.ProcessEnv = process.env
): Promise<RbacEntryResult> {
  // Bootstrap FIRST: an unbootstrapped deployment must be able to become
  // administrable on the very first request, not one request later.
  await ensureBootstrap(env);
  const actor = trustedIdentityFromHeaders(headers, env);
  if (!actor) return { actor: null, authorized: false, roles: [] };
  // 021G-2: a store failure must render the refusal card, NOT throw. An
  // unhandled rejection here would surface as a server error on the admin page,
  // which tells an operator nothing and looks like an outage rather than a
  // refusal. Fail closed: no actor keeps their authority when the store that
  // holds it cannot be read.
  try {
    // Both awaited: an unawaited Promise is truthy and would grant access.
    const authorized = await actorHasCapability(actor, capability);
    return { actor, authorized, roles: await currentRoles(actor.oid) };
  } catch {
    return { actor, authorized: false, roles: [] };
  }
}
