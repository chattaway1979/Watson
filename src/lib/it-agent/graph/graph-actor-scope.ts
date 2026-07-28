// ============================================================
// Watson — WATSON-MANAGED-IDENTITY-GRAPH-READINESS-011B (SERVER-ONLY)
// Actor-to-target isolation for the employee self-diagnosis pilot.
// ------------------------------------------------------------
// WHY THIS EXISTS
// The Graph credential is APP-ONLY: it can read every user in the tenant. Graph
// therefore provides NO containment whatsoever. Containment is enforced here,
// in Watson's own policy layer, and nowhere else. A Graph permission or an
// Azure role must never be mistaken for an authorization boundary.
//
// RULES (employee self-diagnosis path)
//   * The diagnostic subject is ALWAYS derived from the verified session
//     identity — never from anything the browser sent.
//   * Any client-supplied target is REFUSED, even one that matches the caller.
//     The field is not part of this contract, so accepting it would create an
//     input surface that does not need to exist.
//   * An employee targeting anyone else is refused as a distinct, more severe
//     outcome, and refused BEFORE any Graph call is made — so no request ever
//     leaves Watson that could confirm or deny another account's existence.
//   * Unknown or ambiguous session-to-directory mapping fails CLOSED.
//   * Administrator targeting of other users is a separate, separately
//     authorized surface and is explicitly out of scope here.
//
// This module is pure: no network, no Graph, no I/O.
// ============================================================
import type { Actor } from '../types';

export type ScopeDenyReason =
  | 'no_authenticated_actor'        // unauthenticated
  | 'identity_unmapped'             // session carries no usable directory identity
  | 'identity_ambiguous'            // session identity is not a single usable value
  | 'client_supplied_target'        // browser tried to name a subject at all
  | 'cross_user_target'             // browser tried to name a DIFFERENT subject
  | 'admin_targeting_out_of_scope'; // admin cross-user targeting belongs elsewhere

export type ScopeDecision =
  | { allowed: true; subject: string; subjectSource: 'verified_session_identity' }
  | { allowed: false; reason: ScopeDenyReason };

// Deliberately strict: a single '@', no whitespace, a dotted domain. Anything
// that could alter a Graph path (slashes, '?', '$', ':', control characters) is
// rejected before it can be interpolated into a URL.
const SAFE_UPN = /^[^\s@/\\?#$&:;'"<>]+@[^\s@/\\?#$&:;'"<>]+\.[^\s@/\\?#$&:;'"<>]+$/;
const MAX_UPN_LEN = 320;

export function normalizeDirectoryIdentity(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (!v || v.length > MAX_UPN_LEN) return null;
  if (!SAFE_UPN.test(v)) return null;
  return v;
}

// Resolve the ONLY subject an employee may diagnose: themselves.
//
// `clientSuppliedTarget` is whatever arrived from the browser (query string,
// body, header). It is accepted as a parameter solely so it can be explicitly
// REFUSED and audited — it is never used to choose a subject.
export function resolveEmployeeDiagnosticSubject(opts: {
  actor: Actor | null | undefined;
  clientSuppliedTarget?: string | null;
}): ScopeDecision {
  const actor = opts.actor;
  if (!actor) return { allowed: false, reason: 'no_authenticated_actor' };

  // Admin cross-user diagnosis is a different, separately authorized surface.
  // Refusing it here keeps this path single-purpose and impossible to widen.
  if (actor.role === 'admin') return { allowed: false, reason: 'admin_targeting_out_of_scope' };

  const subject = normalizeDirectoryIdentity(actor.email);
  if (!subject) {
    // No usable directory identity on the verified session: we cannot prove who
    // this is, so we diagnose nobody. Fail closed.
    return { allowed: false, reason: 'identity_unmapped' };
  }

  const supplied = typeof opts.clientSuppliedTarget === 'string' ? opts.clientSuppliedTarget.trim() : '';
  if (supplied) {
    const normalizedSupplied = normalizeDirectoryIdentity(supplied);
    // A different subject — or an unparseable one — is a cross-user attempt.
    // Both are refused identically so the response cannot be used to probe
    // whether an address is well-formed or exists.
    if (normalizedSupplied !== subject) return { allowed: false, reason: 'cross_user_target' };
    // Matches self, but the browser still must not be naming subjects.
    return { allowed: false, reason: 'client_supplied_target' };
  }

  return { allowed: true, subject, subjectSource: 'verified_session_identity' };
}

// Case ownership and diagnostic subject must stay aligned: evidence attached to
// a case must concern that case's owner. Ambiguity fails closed.
export function caseSubjectAligned(
  caseOwnerEmail: string | null | undefined,
  subject: string | null | undefined
): boolean {
  const owner = normalizeDirectoryIdentity(caseOwnerEmail);
  const subj = normalizeDirectoryIdentity(subject);
  if (!owner || !subj) return false;
  return owner === subj;
}

// Guard for the eventual live path: returns the subject ONLY when a Graph call
// is permissible. Callers must treat `null` as "do not call Graph". Keeping the
// decision and the call site adjacent makes a cross-user Graph request a
// structural impossibility rather than a review item.
export function graphSubjectOrNull(decision: ScopeDecision): string | null {
  return decision.allowed ? decision.subject : null;
}

// Audit-safe projection of a decision. Emits the reason CODE only — never the
// attempted target, so a refused cross-user attempt cannot leak the probed
// address into the audit trail.
export function scopeDecisionForAudit(decision: ScopeDecision): { allowed: boolean; reason?: ScopeDenyReason } {
  return decision.allowed ? { allowed: true } : { allowed: false, reason: decision.reason };
}
