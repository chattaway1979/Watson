// ============================================================
// Watson — 012 : Endpoint permission and consent tiers (Part F)
// ------------------------------------------------------------
// Watson is being designed to eventually inspect and repair employee Windows
// computers through a signed agent deployed by Intune. Nothing in this module
// touches a real device: it defines the permission model that any future agent
// must obey, and the mock runtime enforces it today so the rules are tested
// long before they are load-bearing.
//
// The central rule: the language model may SELECT from this catalogue. It may
// never COMPOSE a command. Tier 4 exists to name, explicitly, the things that
// must remain impossible rather than merely discouraged.
// ============================================================

export type EndpointTier = 0 | 1 | 2 | 3 | 4;

export type ApprovalAuthority = 'none' | 'employee' | 'administrator' | 'separate_workflow';

export interface TierDefinition {
  readonly tier: EndpointTier;
  readonly label: string;
  readonly description: string;
  readonly approval: ApprovalAuthority;
  // May this tier change anything on the device at all?
  readonly mutatesDevice: boolean;
  // Must a rollback path exist and be proven before execution?
  readonly requiresRollback: boolean;
  // Must the employee be shown a live indicator while this runs?
  readonly requiresVisibleIndicator: boolean;
}

export const ENDPOINT_TIERS: Record<EndpointTier, TierDefinition> = {
  0: {
    tier: 0, label: 'Observation only',
    description: 'Inspect status, collect logs, read approved configuration, detect errors. No change of any kind.',
    approval: 'none', mutatesDevice: false, requiresRollback: false, requiresVisibleIndicator: true
  },
  1: {
    tier: 1, label: 'Low-risk autonomous',
    description: 'Launch or restart an approved application, retry a failed sync, test a known-good file, refresh reversible state — only after unsaved work is confirmed protected.',
    approval: 'none', mutatesDevice: true, requiresRollback: true, requiresVisibleIndicator: true
  },
  2: {
    tier: 2, label: 'Employee approval required',
    description: 'End a hung process, reset an application profile, clear approved caches, repair an installation, modify user-level settings, restore a backup.',
    approval: 'employee', mutatesDevice: true, requiresRollback: true, requiresVisibleIndicator: true
  },
  3: {
    tier: 3, label: 'Administrator approval required',
    description: 'Elevation, machine-wide software changes, reinstalls, registry, drivers, Windows services, Intune remediation, Microsoft 365 permission changes, anything affecting multiple users or devices.',
    approval: 'administrator', mutatesDevice: true, requiresRollback: true, requiresVisibleIndicator: true
  },
  4: {
    tier: 4, label: 'Prohibited without a separately approved workflow',
    description: 'Deleting employee files, disabling security controls, weakening Defender or Intune policy, bypassing authentication, collecting passwords, exposing tokens, unrestricted shell, silent control, production tenant permission changes, executing model-generated commands.',
    approval: 'separate_workflow', mutatesDevice: true, requiresRollback: true, requiresVisibleIndicator: true
  }
};

// Tier 4 is not "high risk" — it is out of bounds for this system entirely.
// Anything routed here must be refused, not escalated for approval.
export function isProhibited(tier: EndpointTier): boolean {
  return tier === 4;
}

export function approvalFor(tier: EndpointTier): ApprovalAuthority {
  return ENDPOINT_TIERS[tier].approval;
}

// The named classes of Tier 4 activity. Listing them makes the boundary
// testable rather than aspirational.
export const PROHIBITED_CAPABILITIES = [
  'delete_employee_files',
  'disable_security_controls',
  'weaken_defender_or_intune_policy',
  'bypass_authentication',
  'collect_credentials',
  'expose_tokens_or_secrets',
  'unrestricted_shell',
  'silent_device_control',
  'modify_production_tenant_permissions',
  'execute_model_generated_command'
] as const;

export type ProhibitedCapability = typeof PROHIBITED_CAPABILITIES[number];

// ------------------------------------------------------------
// Execution context required by an action. This is what separates "runs as the
// signed service" from "runs in the employee's session" — a distinction that
// determines whether UI Automation is even possible.
// ------------------------------------------------------------
export type ExecutionContext =
  | 'windows_service'     // signed service, machine scope
  | 'current_user'        // the employee's own session
  | 'elevated'            // administrator token required
  | 'interactive_desktop' // needs a visible desktop for UI Automation
  | 'cloud_orchestrator'; // runs in Azure, never on the device

// Preferred navigation strategy, most reliable first. Coordinate clicking is
// last deliberately: it breaks on any resolution, theme, or layout change and
// cannot verify what it actually clicked.
export type NavigationStrategy =
  | 'application_api'
  | 'command_line'
  | 'os_management_api'
  | 'ui_automation'
  | 'browser_automation'
  | 'visual_fallback';

export const NAVIGATION_PREFERENCE: readonly NavigationStrategy[] = [
  'application_api',
  'command_line',
  'os_management_api',
  'ui_automation',
  'browser_automation',
  'visual_fallback'
] as const;

export function navigationRank(s: NavigationStrategy): number {
  const i = NAVIGATION_PREFERENCE.indexOf(s);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

// True when a strategy is being used where a more reliable one was available.
export function isDowngradedStrategy(chosen: NavigationStrategy, available: readonly NavigationStrategy[]): boolean {
  const best = available.reduce<number>((acc, s) => Math.min(acc, navigationRank(s)), Number.MAX_SAFE_INTEGER);
  return navigationRank(chosen) > best;
}

// ------------------------------------------------------------
// Operating modes (Part F item 8). Escalating capability is gated on the
// previous mode being proven, not on confidence.
// ------------------------------------------------------------
export type OperatingMode = 'guided' | 'assisted_control' | 'autonomous_remediation';

export interface ModeDefinition {
  readonly mode: OperatingMode;
  readonly description: string;
  readonly maxTier: EndpointTier;
  readonly employeePerformsActions: boolean;
  readonly requiresPriorModeProven: OperatingMode | null;
}

export const OPERATING_MODES: Record<OperatingMode, ModeDefinition> = {
  guided: {
    mode: 'guided',
    description: 'Watson explains what it is checking; the employee performs actions or approves each one. Appropriate for the first pilots.',
    maxTier: 0,
    employeePerformsActions: true,
    requiresPriorModeProven: null
  },
  assisted_control: {
    mode: 'assisted_control',
    description: 'Watson operates approved application controls. The employee watches the session and can stop it. Impactful actions still require explicit approval.',
    maxTier: 2,
    employeePerformsActions: false,
    requiresPriorModeProven: 'guided'
  },
  autonomous_remediation: {
    mode: 'autonomous_remediation',
    description: 'Pre-approved low-risk actions only, and only after guided and assisted modes are proven reliable. There is no unrestricted autonomous desktop control at any point.',
    maxTier: 1,
    employeePerformsActions: false,
    requiresPriorModeProven: 'assisted_control'
  }
};

// Autonomous mode caps at Tier 1 ON PURPOSE: it is narrower than assisted mode,
// not broader. Removing the human from the loop must reduce reach, not raise it.
export function maxTierForMode(mode: OperatingMode): EndpointTier {
  return OPERATING_MODES[mode].maxTier;
}
