// ============================================================
// Watson — H&R AI IT Agent : Constants & Safety Configuration
// ============================================================
import type { Role } from './types';

export const PRODUCT_NAME = 'Watson — H&R AI IT Agent';
export const PRODUCT_SHORT = 'Watson';
export const COMPANY_NAME = 'H&R Electric Company';

// Role hierarchy. Higher number = more privilege.
export const ROLE_RANK: Record<Role, number> = {
  system: 100,
  owner: 90,
  admin: 80,
  agent: 50, // Watson agent acts with limited, NEVER-approving authority
  manager: 40,
  employee: 10
};

export function roleAtLeast(actorRole: Role, minimum: Role): boolean {
  return ROLE_RANK[actorRole] >= ROLE_RANK[minimum];
}

// ---- SAFETY MASTER SWITCH ---------------------------------
// Backend-owned gate for any real external execution.
// This reads from the environment and DEFAULTS TO FALSE.
// Nothing in this build flips it to true.
export function isLiveExternalExecutionEnabled(): boolean {
  const raw = (process.env.IT_AGENT_LIVE_EXTERNAL_EXECUTION ?? 'false').toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

export function operatingMode(): 'mock' | 'live' {
  // Even if someone sets IT_AGENT_MODE=live, live execution stays gated by the
  // execution enforcement layer, which independently checks the master switch.
  return isLiveExternalExecutionEnabled() ? 'live' : 'mock';
}

export const SAFETY_BANNER =
  'MOCK MODE — live external IT execution is disabled. Risky and critical actions are queued for human approval and simulated only.';

// Display labels
export const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  triaged: 'Triaged',
  waiting_on_employee: 'Waiting on Employee',
  waiting_on_admin: 'Waiting on Admin',
  approval_required: 'Approval Required',
  in_progress: 'In Progress',
  resolved: 'Resolved',
  closed: 'Closed',
  cancelled: 'Cancelled'
};

export const CATEGORY_LABELS: Record<string, string> = {
  email_setup: 'Email Setup',
  outlook: 'Outlook',
  teams: 'Microsoft Teams',
  onedrive: 'OneDrive',
  password_mfa: 'Password / MFA',
  printer: 'Printer',
  network: 'Network / Wi-Fi / VPN',
  device_slow: 'Slow Device',
  device_access: 'Device Access',
  software_install: 'Software Install',
  sharepoint_access: 'SharePoint Access',
  onboarding: 'Onboarding',
  offboarding: 'Offboarding',
  security: 'Security',
  other: 'Other'
};

export const PRIORITY_LABELS: Record<string, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent'
};

export const RISK_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical'
};
