// ============================================================
// Watson — 021A : Application role registry (SINGLE SOURCE OF TRUTH)
// ------------------------------------------------------------
// These are WATSON APPLICATION roles. They are not Microsoft Entra directory
// roles, Microsoft 365 administrator roles, Azure RBAC roles, or Graph
// application permissions, and holding one grants no authority in any of those
// systems. That distinction is stated in the registry itself because it is the
// single most likely thing for an administrator to misunderstand.
//
// The registry is fixed and version-controlled. There are no custom roles, no
// wildcard roles, no arbitrary permission strings, and no superadmin. Server
// authorization and (later) the UI both derive from this file, so the two can
// never drift apart.
//
// Pure data + pure functions. No network, no I/O, no side effects.
// ============================================================

export const WATSON_ROLE_KEYS = [
  'watson_employee',
  'watson_technician',
  'watson_support_admin',
  'watson_provisioning_admin',
  'watson_security_admin',
  'watson_role_admin'
] as const;

export type WatsonRoleKey = typeof WATSON_ROLE_KEYS[number];

export type RiskClass = 'standard' | 'elevated' | 'high';

// Capabilities are a closed vocabulary. A capability that is not listed here
// cannot be granted, which is what prevents a reserved role from quietly
// acquiring real power later.
export const CAPABILITIES = [
  'case.own.create', 'case.own.read', 'case.own.evidence',
  'case.assigned.read', 'case.assigned.note', 'case.handoff.read', 'case.route',
  'admin.support.read',
  'rbac.registry.read', 'rbac.employee.read', 'rbac.assign', 'rbac.remove', 'rbac.audit.read',
  // Reserved: named so the UI can show intent, but no server operation consumes
  // them and no live capability is wired to them.
  'reserved.provisioning.approve',
  'reserved.security.approve'
] as const;

export type Capability = typeof CAPABILITIES[number];

// Capabilities that MUST NOT map to any executable operation in this build.
// Asserted by tests so a future change cannot silently activate them.
export const RESERVED_CAPABILITIES: readonly Capability[] = [
  'reserved.provisioning.approve',
  'reserved.security.approve'
] as const;

export interface WatsonRole {
  readonly key: WatsonRoleKey;
  readonly displayName: string;
  readonly description: string;
  readonly capabilities: readonly Capability[];
  readonly risk: RiskClass;
  // Which role keys may assign / remove this role. Empty means nobody through
  // the ordinary flow (bootstrap only).
  readonly assignableBy: readonly WatsonRoleKey[];
  readonly removableBy: readonly WatsonRoleKey[];
  readonly requiresElevatedConfirmation: boolean;
  readonly selfAssignable: boolean;
  readonly selfRemovable: boolean;
  // 'functional' — the capabilities do something today.
  // 'reserved'   — assignable and enforced, but deliberately inert.
  readonly status: 'functional' | 'reserved';
}

export const WATSON_ROLES: Record<WatsonRoleKey, WatsonRole> = {
  watson_employee: {
    key: 'watson_employee',
    displayName: 'Employee',
    description: 'Use Watson for personal IT support. Sees only their own cases.',
    capabilities: ['case.own.create', 'case.own.read', 'case.own.evidence'],
    risk: 'standard',
    assignableBy: ['watson_role_admin'],
    removableBy: ['watson_role_admin'],
    requiresElevatedConfirmation: false,
    selfAssignable: false,
    selfRemovable: false,
    status: 'functional'
  },
  watson_technician: {
    key: 'watson_technician',
    displayName: 'Technician',
    description: 'Works assigned or routed support cases and reads sanitised handoffs.',
    capabilities: ['case.assigned.read', 'case.assigned.note', 'case.handoff.read'],
    risk: 'standard',
    assignableBy: ['watson_role_admin'],
    removableBy: ['watson_role_admin'],
    requiresElevatedConfirmation: false,
    selfAssignable: false,
    selfRemovable: false,
    status: 'functional'
  },
  watson_support_admin: {
    key: 'watson_support_admin',
    displayName: 'Support administrator',
    description: 'Manages support operations and case routing. Confers NO role-administration authority.',
    capabilities: ['case.assigned.read', 'case.handoff.read', 'case.route', 'admin.support.read'],
    risk: 'elevated',
    assignableBy: ['watson_role_admin'],
    removableBy: ['watson_role_admin'],
    requiresElevatedConfirmation: false,
    selfAssignable: false,
    selfRemovable: false,
    status: 'functional'
  },
  watson_provisioning_admin: {
    key: 'watson_provisioning_admin',
    displayName: 'Provisioning administrator (reserved)',
    description: 'Reserved for future employee-account and email provisioning APPROVAL. Creates nothing today.',
    capabilities: ['reserved.provisioning.approve'],
    risk: 'high',
    assignableBy: ['watson_role_admin'],
    removableBy: ['watson_role_admin'],
    requiresElevatedConfirmation: true,
    selfAssignable: false,
    selfRemovable: true,
    status: 'reserved'
  },
  watson_security_admin: {
    key: 'watson_security_admin',
    displayName: 'Security administrator (reserved)',
    description: 'Reserved for future phishing review and Defender remediation APPROVAL. Remediates nothing today.',
    capabilities: ['reserved.security.approve'],
    risk: 'high',
    assignableBy: ['watson_role_admin'],
    removableBy: ['watson_role_admin'],
    requiresElevatedConfirmation: true,
    selfAssignable: false,
    selfRemovable: true,
    status: 'reserved'
  },
  watson_role_admin: {
    key: 'watson_role_admin',
    displayName: 'Role administrator',
    description: 'Administers Watson application-role assignments only. Confers no Microsoft tenant authority.',
    capabilities: ['rbac.registry.read', 'rbac.employee.read', 'rbac.assign', 'rbac.remove', 'rbac.audit.read'],
    risk: 'high',
    assignableBy: ['watson_role_admin'],
    removableBy: ['watson_role_admin'],
    requiresElevatedConfirmation: true,
    // Self-elevation is impossible by construction, not merely by policy check.
    selfAssignable: false,
    selfRemovable: true,
    status: 'functional'
  }
};

// The statement shown on every assignment/removal preview.
export const WATSON_ROLE_DISCLAIMER =
  'This changes Watson application access only. It does not grant a Microsoft 365 or Entra administrator role.';

// ------------------------------------------------------------
// Registry helpers. `isWatsonRoleKey` is the ONLY way a string becomes a role
// key — it rejects case variants, Unicode look-alikes, whitespace and
// null-byte/delimiter tricks by requiring an exact match against the frozen list.
// ------------------------------------------------------------
export function isWatsonRoleKey(v: unknown): v is WatsonRoleKey {
  return typeof v === 'string' && (WATSON_ROLE_KEYS as readonly string[]).includes(v);
}

export function getRole(key: WatsonRoleKey): WatsonRole {
  return WATSON_ROLES[key];
}

export function capabilitiesFor(roles: readonly WatsonRoleKey[]): Capability[] {
  const out = new Set<Capability>();
  for (const r of roles) for (const c of WATSON_ROLES[r].capabilities) out.add(c);
  return [...out].sort();
}

export function hasCapability(roles: readonly WatsonRoleKey[], cap: Capability): boolean {
  return capabilitiesFor(roles).includes(cap);
}

// Reserved capabilities never authorize an operation, whatever roles are held.
export function isReservedCapability(cap: Capability): boolean {
  return RESERVED_CAPABILITIES.includes(cap);
}

// ------------------------------------------------------------
// Segregation of duties. Warnings are mandatory and acknowledged; they are not
// blocking in v1, but the acknowledgement is recorded so a future second-approver
// requirement can be layered on without changing storage.
// ------------------------------------------------------------
export const SOD_PAIRS: ReadonlyArray<readonly [WatsonRoleKey, WatsonRoleKey]> = [
  ['watson_role_admin', 'watson_security_admin'],
  ['watson_role_admin', 'watson_provisioning_admin'],
  ['watson_security_admin', 'watson_provisioning_admin']
] as const;

export function sodWarnings(resultingRoles: readonly WatsonRoleKey[]): string[] {
  const held = new Set(resultingRoles);
  const out: string[] = [];
  for (const [a, b] of SOD_PAIRS) {
    if (held.has(a) && held.has(b)) {
      out.push(`Holding both ${WATSON_ROLES[a].displayName} and ${WATSON_ROLES[b].displayName} concentrates approval authority in one person.`);
    }
  }
  return out;
}

// True when the change needs the administrator to tick an explicit
// acknowledgement before confirmation is accepted.
export function requiresElevatedAcknowledgement(
  role: WatsonRoleKey,
  resultingRoles: readonly WatsonRoleKey[]
): boolean {
  return WATSON_ROLES[role].requiresElevatedConfirmation || sodWarnings(resultingRoles).length > 0;
}

export function canRoleAssign(actorRoles: readonly WatsonRoleKey[], target: WatsonRoleKey): boolean {
  return WATSON_ROLES[target].assignableBy.some((r) => actorRoles.includes(r));
}

export function canRoleRemove(actorRoles: readonly WatsonRoleKey[], target: WatsonRoleKey): boolean {
  return WATSON_ROLES[target].removableBy.some((r) => actorRoles.includes(r));
}
