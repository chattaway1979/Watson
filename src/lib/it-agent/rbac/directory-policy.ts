// ============================================================
// Watson — 021E : Employee directory eligibility policy (SERVER-ONLY, PURE)
// ------------------------------------------------------------
// Decides which tenant identities an administrator may be offered as a Watson
// role target, and — just as importantly — how the rest are labelled.
//
// WHY THIS IS NOT A DOMAIN FILTER
// A survey of the live tenant (021E preflight, 18 identities) found:
//   * userType is "Member" for EVERY identity — including shared mailboxes,
//     service principals-as-users, break-glass accounts and cross-tenant users.
//     On its own it filters nothing.
//   * employeeId, employeeType, creationType and onPremisesSyncEnabled are
//     populated on 0/18. A policy resting on them would silently pass everything.
//   * department/jobTitle are populated on exactly the human accounts, so they
//     are the only reliable positive employee signal this tenant actually has.
//   * A break-glass account exists ON the corporate domain, so "approved domain"
//     alone would present an emergency-access identity as an ordinary employee.
//
// The policy is therefore layered and CONFIGURATION-DRIVEN, and it fails closed:
// an identity is only ever `eligible_employee` when it is enabled, a Member, not
// matched by any exclusion, on an approved domain, AND carries a positive
// employee signal. Everything else gets an explicit, stable reason code.
//
// SEPARATION OF CONCERNS: eligibility governs what SEARCH OFFERS. It is not an
// authorization control and it never gates assignment by object id — an
// administrator who knows a real object id can still act on it, and the security
// core remains the only thing that decides authority. This is deliberate: a
// directory-presentation heuristic must never become a silent security boundary.
// ============================================================

export type EligibilityReasonCode =
  | 'eligible_employee'
  | 'disabled_account'
  | 'guest_account'
  | 'excluded_service_identity'
  | 'excluded_shared_mailbox'
  | 'excluded_bootstrap_identity'
  | 'excluded_cross_tenant_identity'
  | 'ambiguous_member'
  | 'explicitly_allowed'
  | 'explicitly_excluded';

export type EmployeeEligibility = 'eligible' | 'not_eligible' | 'ambiguous';

export interface DirectoryEligibilityPolicy {
  readonly approvedEmployeeDomains: readonly string[];
  // The tenant's own *.onmicrosoft.com style domains. Identities here are
  // bootstrap/administrative rather than staff mailboxes.
  readonly tenantDefaultDomains: readonly string[];
  readonly excludedUserPrincipalNames: readonly string[];
  // Matched (case-insensitive) against the UPN local part.
  readonly excludedAddressPatterns: readonly string[];
  readonly excludedDisplayNamePatterns: readonly string[];
  readonly explicitlyAllowedObjectIds: readonly string[];
  readonly explicitlyExcludedObjectIds: readonly string[];
  // What to do with an enabled Member on an approved domain that carries no
  // positive employee signal.
  readonly ambiguousMemberHandling: 'hide' | 'warn';
}

// Defaults derived from the observed tenant. Every value is overridable through
// configuration; none of it is hard-coded at a call site.
export const DEFAULT_DIRECTORY_POLICY: DirectoryEligibilityPolicy = {
  approvedEmployeeDomains: ['hrelectriccompany.com'],
  tenantDefaultDomains: ['onmicrosoft.com'],
  excludedUserPrincipalNames: [],
  excludedAddressPatterns: [
    '^breakglass', '^break-glass', '^emergency',
    '^info$', '^estimating$', '^accounts?$', '^billing$', '^sales$', '^support$',
    '^admin$', '^administrator$', '^helpdesk$', '^it$',
    '^noreply', '^no-reply', '^postmaster', '^mailer', '^journaling', '^journal',
    '^mdmpushcert', '^zzo365', '^svc[-_.]', '^service[-_.]', '^sa[-_.]'
  ],
  excludedDisplayNamePatterns: [
    'break.?glass', 'emergency access', 'service account', 'shared mailbox',
    'inbox', 'push certificate', 'journal', 'tenant service', 'automation',
    'do not reply', 'discovery search'
  ],
  explicitlyAllowedObjectIds: [],
  explicitlyExcludedObjectIds: [],
  ambiguousMemberHandling: 'warn'
};

export class DirectoryPolicyError extends Error {}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asStringArray(v: unknown, field: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new DirectoryPolicyError(`policy field "${field}" must be an array of strings`);
  }
  return (v as string[]).map((s) => s.trim()).filter(Boolean);
}

function assertValidRegexes(patterns: readonly string[], field: string): void {
  for (const p of patterns) {
    try { new RegExp(p, 'i'); } catch {
      throw new DirectoryPolicyError(`policy field "${field}" contains an invalid pattern`);
    }
  }
}

// Parse policy overrides from configuration. Malformed configuration THROWS —
// the caller turns that into a fail-closed "directory unavailable" rather than
// quietly running on a policy nobody verified.
export function loadDirectoryPolicy(env: NodeJS.ProcessEnv = process.env): DirectoryEligibilityPolicy {
  const raw = env.WATSON_DIRECTORY_POLICY?.trim();
  if (!raw) return DEFAULT_DIRECTORY_POLICY;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new DirectoryPolicyError('WATSON_DIRECTORY_POLICY is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DirectoryPolicyError('WATSON_DIRECTORY_POLICY must be a JSON object');
  }

  const handling = parsed.ambiguousMemberHandling ?? DEFAULT_DIRECTORY_POLICY.ambiguousMemberHandling;
  if (handling !== 'hide' && handling !== 'warn') {
    throw new DirectoryPolicyError('ambiguousMemberHandling must be "hide" or "warn"');
  }

  const allowed = asStringArray(parsed.explicitlyAllowedObjectIds, 'explicitlyAllowedObjectIds');
  const excluded = asStringArray(parsed.explicitlyExcludedObjectIds, 'explicitlyExcludedObjectIds');
  for (const id of [...allowed, ...excluded]) {
    if (!GUID.test(id)) {
      throw new DirectoryPolicyError('object id lists must contain immutable object ids only');
    }
  }

  const addr = asStringArray(parsed.excludedAddressPatterns, 'excludedAddressPatterns');
  const disp = asStringArray(parsed.excludedDisplayNamePatterns, 'excludedDisplayNamePatterns');
  assertValidRegexes(addr, 'excludedAddressPatterns');
  assertValidRegexes(disp, 'excludedDisplayNamePatterns');

  const domains = asStringArray(parsed.approvedEmployeeDomains, 'approvedEmployeeDomains');
  if (parsed.approvedEmployeeDomains !== undefined && domains.length === 0) {
    // An empty approved-domain list would make every identity cross-tenant. That
    // is almost certainly a mistake, and silently hiding the whole directory is
    // worse than refusing to start with it.
    throw new DirectoryPolicyError('approvedEmployeeDomains must not be empty when supplied');
  }

  return {
    approvedEmployeeDomains: domains.length ? domains.map((d) => d.toLowerCase()) : DEFAULT_DIRECTORY_POLICY.approvedEmployeeDomains,
    tenantDefaultDomains: (asStringArray(parsed.tenantDefaultDomains, 'tenantDefaultDomains').length
      ? asStringArray(parsed.tenantDefaultDomains, 'tenantDefaultDomains')
      : [...DEFAULT_DIRECTORY_POLICY.tenantDefaultDomains]).map((d) => d.toLowerCase()),
    excludedUserPrincipalNames: asStringArray(parsed.excludedUserPrincipalNames, 'excludedUserPrincipalNames').map((u) => u.toLowerCase()),
    excludedAddressPatterns: addr.length ? addr : DEFAULT_DIRECTORY_POLICY.excludedAddressPatterns,
    excludedDisplayNamePatterns: disp.length ? disp : DEFAULT_DIRECTORY_POLICY.excludedDisplayNamePatterns,
    explicitlyAllowedObjectIds: allowed.map((s) => s.toLowerCase()),
    explicitlyExcludedObjectIds: excluded.map((s) => s.toLowerCase()),
    ambiguousMemberHandling: handling
  };
}

// The attributes the policy consumes. Deliberately a narrow view of a Graph
// user: nothing else is read, so nothing else can influence the decision.
export interface DirectoryCandidate {
  oid: string;
  displayName: string;
  userPrincipalName: string;
  mail: string | null;
  userType: string | null;
  accountEnabled: boolean | null;
  employeeId: string | null;
  employeeType: string | null;
  department: string | null;
  jobTitle: string | null;
}

export interface EligibilityDecision {
  employeeEligibility: EmployeeEligibility;
  eligibilityReasonCode: EligibilityReasonCode;
  selectionAllowed: boolean;
  // True when the policy says this row should not be listed at all.
  hidden: boolean;
}

const domainOf = (upn: string): string => {
  const at = upn.lastIndexOf('@');
  return at === -1 ? '' : upn.slice(at + 1).toLowerCase();
};
const localPartOf = (upn: string): string => {
  const at = upn.lastIndexOf('@');
  return (at === -1 ? upn : upn.slice(0, at)).toLowerCase();
};
const matchesAny = (value: string, patterns: readonly string[]): boolean =>
  patterns.some((p) => { try { return new RegExp(p, 'i').test(value); } catch { return false; } });

// Evaluate one candidate. Pure; order matters and is asserted by tests.
export function evaluateEligibility(
  c: DirectoryCandidate,
  policy: DirectoryEligibilityPolicy = DEFAULT_DIRECTORY_POLICY
): EligibilityDecision {
  const oid = (c.oid ?? '').toLowerCase();
  const upn = (c.userPrincipalName ?? '').toLowerCase();
  const domain = domainOf(upn);
  const local = localPartOf(upn);
  const display = c.displayName ?? '';

  const not = (reason: EligibilityReasonCode): EligibilityDecision =>
    ({ employeeEligibility: 'not_eligible', eligibilityReasonCode: reason, selectionAllowed: false, hidden: false });

  // 1. An account that cannot sign in is never a useful role target, whatever
  //    else it is. Checked first so a disabled service account reads as disabled.
  if (c.accountEnabled === false) return not('disabled_account');

  // 2. Anything that is not a Member is external by definition.
  if (c.userType !== null && c.userType !== undefined && String(c.userType).toLowerCase() !== 'member') {
    return not('guest_account');
  }

  // 3. Explicit configuration wins over every heuristic below it.
  if (policy.explicitlyExcludedObjectIds.includes(oid)) return not('explicitly_excluded');
  if (policy.explicitlyAllowedObjectIds.includes(oid)) {
    return { employeeEligibility: 'eligible', eligibilityReasonCode: 'explicitly_allowed', selectionAllowed: true, hidden: false };
  }
  if (policy.excludedUserPrincipalNames.includes(upn)) return not('excluded_service_identity');

  // 4. Domain placement. An identity on the tenant's default domain is a
  //    bootstrap/administrative object, not a staff mailbox.
  const onApproved = policy.approvedEmployeeDomains.some((d) => domain === d || domain.endsWith('.' + d));
  const onTenantDefault = policy.tenantDefaultDomains.some((d) => domain === d || domain.endsWith('.' + d));
  if (!onApproved) return not(onTenantDefault ? 'excluded_bootstrap_identity' : 'excluded_cross_tenant_identity');

  // 5. Named-shape exclusions WITHIN the approved domain. A break-glass account
  //    on the corporate domain is exactly why domain alone is insufficient.
  if (/^break.?glass|^emergency/i.test(local) || /break.?glass|emergency access/i.test(display)) {
    return not('excluded_bootstrap_identity');
  }
  if (matchesAny(display, policy.excludedDisplayNamePatterns)) {
    return not(/inbox|shared mailbox/i.test(display) ? 'excluded_shared_mailbox' : 'excluded_service_identity');
  }
  if (matchesAny(local, policy.excludedAddressPatterns)) {
    const sharedish = /^(info|estimating|accounts?|billing|sales|support|helpdesk)$/i.test(local);
    return not(sharedish ? 'excluded_shared_mailbox' : 'excluded_service_identity');
  }

  // 6. A positive employee signal is REQUIRED. Absent one, the identity is
  //    ambiguous and must not be presented as a confirmed employee.
  const hasSignal = Boolean(
    (c.employeeId && c.employeeId.trim()) ||
    (c.employeeType && c.employeeType.trim()) ||
    (c.department && c.department.trim()) ||
    (c.jobTitle && c.jobTitle.trim())
  );
  if (!hasSignal || c.accountEnabled !== true) {
    return {
      employeeEligibility: 'ambiguous',
      eligibilityReasonCode: 'ambiguous_member',
      selectionAllowed: false,
      hidden: policy.ambiguousMemberHandling === 'hide'
    };
  }

  return { employeeEligibility: 'eligible', eligibilityReasonCode: 'eligible_employee', selectionAllowed: true, hidden: false };
}
