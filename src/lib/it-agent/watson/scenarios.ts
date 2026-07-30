// ============================================================
// Watson — H&R AI IT Agent : Deterministic scenario knowledge base
// ------------------------------------------------------------
// The mock "reasoning" for V1. Everything here is rule-based and deterministic
// so tests never depend on model output. It maps an employee statement to a
// scenario, a plain-language diagnostic plan, hypotheses, a proposed simulated
// repair, and a rule-based time estimate. No tool/action names are exposed to
// employees — only the plain-language labels in `plan`.
// ============================================================
import type { Platform, ScenarioKey, Reversibility, ApprovalLevel, TimeEstimate } from './cases';

import { BLUEBEAM_SCENARIO_DEFS, classifyBluebeamScenarioKey } from './bluebeam-bridge';

export type CheckKind = 'account' | 'm365_service' | 'this_device' | 'signin' | 'service_health';
export interface CheckSpec {
  label: string;                 // employee-safe, e.g. "Checking your account"
  kind: CheckKind;
  // Optional M365 read to run via the existing diagnostic system.
  read?: 'lookup_user' | 'check_license_status' | 'check_mfa_status' | 'check_mailbox_status' | 'check_group_membership';
}

export interface SimulatedActionDef {
  key: string;
  title: string;                 // employee-safe
  explanation: string;
  platforms: Platform[];
  preconditions: string[];
  riskLevel: 'low' | 'medium';
  approvalLevel: ApprovalLevel;
  reversibility: Reversibility;
  expectedInterruption: string;
  minMinutes: number;
  maxMinutes: number;
  requiresRestart: boolean;
  requiresDownload: boolean;
  requiresUserParticipation: boolean;
  steps: string[];
  safeStopAfterSteps: number[];  // step indices after which a safe stop is allowed
  verificationSteps: string[];
  rollback: string;
}

export interface ScenarioDef {
  key: ScenarioKey;
  label: string;
  platforms: Platform[] | 'any';
  autoEscalate?: 'security' | 'general';
  routingCategory: string;
  plan: string[];
  checks: CheckSpec[];
  primaryHypothesis: { key: string; label: string };
  competingHypotheses: { key: string; label: string }[];
  repairActionKey?: string;      // undefined => no safe auto-repair (escalate)
  employeeExplanation?: string;  // plain-language template when repair proposed
  followupNeeds: string[];       // facts to ask for (one at a time) if unknown
}

// ------------------------------------------------------------
// Simulated repair actions (Part J). NONE performs a real change.
// ------------------------------------------------------------
export const SIMULATED_ACTIONS: Record<string, SimulatedActionDef> = {
  refresh_signin: {
    key: 'refresh_signin',
    title: 'Refresh your Outlook sign-in',
    explanation: 'Sign Outlook out and back in to renew an expired session. Outlook will close briefly.',
    platforms: ['windows', 'macos'],
    preconditions: ['account_healthy', 'device_reachable'],
    riskLevel: 'low',
    approvalLevel: 'employee',
    reversibility: 'reversible',
    expectedInterruption: 'Outlook closes for under a minute.',
    minMinutes: 3, maxMinutes: 5,
    requiresRestart: false, requiresDownload: false, requiresUserParticipation: true,
    steps: ['Close Outlook', 'Clear the cached sign-in token', 'Reopen Outlook', 'Sign in and confirm mail loads'],
    safeStopAfterSteps: [0, 1],
    verificationSteps: ['Outlook opens without prompting for sign-in', 'New mail appears'],
    rollback: 'No change persists; simply reopen Outlook if stopped early.'
  },
  trigger_device_sync: {
    key: 'trigger_device_sync',
    title: 'Sync this device with management',
    explanation: 'Ask the device to check in with company management to refresh access policies.',
    platforms: ['windows', 'macos', 'ios', 'ipados'],
    preconditions: ['device_managed'],
    riskLevel: 'low',
    approvalLevel: 'employee',
    reversibility: 'reversible',
    expectedInterruption: 'None — runs in the background.',
    minMinutes: 5, maxMinutes: 10,
    requiresRestart: false, requiresDownload: false, requiresUserParticipation: false,
    steps: ['Queue a management sync', 'Wait for policies to refresh', 'Confirm access'],
    safeStopAfterSteps: [0],
    verificationSteps: ['Device reports a recent successful check-in'],
    rollback: 'A sync makes no destructive change.'
  },
  refresh_onedrive: {
    key: 'refresh_onedrive',
    title: 'Restart OneDrive sync',
    explanation: 'Restart the OneDrive sync engine to clear a stuck sync.',
    platforms: ['windows', 'macos'],
    preconditions: ['account_healthy'],
    riskLevel: 'low',
    approvalLevel: 'employee',
    reversibility: 'reversible',
    expectedInterruption: 'Syncing pauses for a moment.',
    minMinutes: 3, maxMinutes: 8,
    requiresRestart: false, requiresDownload: false, requiresUserParticipation: false,
    steps: ['Pause OneDrive', 'Reset the sync connection', 'Resume OneDrive', 'Confirm files update'],
    safeStopAfterSteps: [0, 1],
    verificationSteps: ['OneDrive shows "Up to date"'],
    rollback: 'Resuming OneDrive restores the prior state.'
  },
  restart_app: {
    key: 'restart_app',
    title: 'Restart the affected app',
    explanation: 'Close and reopen the app to clear a temporary glitch.',
    platforms: ['windows', 'macos', 'ios', 'ipados'],
    preconditions: [],
    riskLevel: 'low',
    approvalLevel: 'employee',
    reversibility: 'reversible',
    expectedInterruption: 'The app closes for a few seconds.',
    minMinutes: 2, maxMinutes: 5,
    requiresRestart: false, requiresDownload: false, requiresUserParticipation: true,
    steps: ['Close the app', 'Reopen the app', 'Retry the action'],
    safeStopAfterSteps: [0],
    verificationSteps: ['The app opens and the feature works'],
    rollback: 'No change persists.'
  },
  reinstall_app: {
    key: 'reinstall_app',
    title: 'Reinstall the managed app',
    explanation: 'Remove and reinstall the app from the company portal to fix a broken install.',
    platforms: ['ios', 'ipados', 'windows', 'macos'],
    preconditions: ['device_managed'],
    riskLevel: 'medium',
    approvalLevel: 'employee',
    reversibility: 'reversible_with_caveats',
    expectedInterruption: 'The app is unavailable during reinstall.',
    minMinutes: 15, maxMinutes: 30,
    requiresRestart: false, requiresDownload: true, requiresUserParticipation: true,
    steps: ['Remove the app', 'Reinstall from the company portal', 'Sign in', 'Verify permissions'],
    safeStopAfterSteps: [0],
    verificationSteps: ['The app launches and its features work'],
    rollback: 'Reinstalling restores the app; local unsynced app data may be lost.'
  },
  restart_device: {
    key: 'restart_device',
    title: 'Restart your device',
    explanation: 'A restart clears memory and can resolve slowness.',
    platforms: ['windows', 'macos', 'ios', 'ipados'],
    preconditions: [],
    riskLevel: 'low',
    approvalLevel: 'employee',
    reversibility: 'reversible',
    expectedInterruption: 'The device is unavailable for a couple of minutes.',
    minMinutes: 5, maxMinutes: 10,
    requiresRestart: true, requiresDownload: false, requiresUserParticipation: true,
    steps: ['Save open work', 'Restart the device', 'Sign back in'],
    safeStopAfterSteps: [0],
    verificationSteps: ['The device is responsive after restart'],
    rollback: 'A restart makes no destructive change.'
  }
};

// ------------------------------------------------------------
// Scenario catalog.
// ------------------------------------------------------------
const BASE_SCENARIOS: Record<string, ScenarioDef> = {
  outlook_repeated_signin: {
    key: 'outlook_repeated_signin',
    label: 'Outlook keeps asking to sign in',
    platforms: ['windows', 'macos'],
    routingCategory: 'Microsoft 365',
    plan: ['Checking your account', 'Checking Microsoft 365', 'Reviewing recent sign-in activity'],
    checks: [
      { label: 'Checking your account', kind: 'account', read: 'lookup_user' },
      { label: 'Checking your Microsoft 365 licence', kind: 'm365_service', read: 'check_license_status' },
      { label: 'Checking your mailbox', kind: 'm365_service', read: 'check_mailbox_status' },
      { label: 'Reviewing recent sign-in activity', kind: 'signin' }
    ],
    primaryHypothesis: { key: 'expired_session', label: 'An expired Outlook sign-in session on this computer' },
    competingHypotheses: [
      { key: 'account_disabled', label: 'The account is disabled or blocked' },
      { key: 'license_missing', label: 'A missing or expired Microsoft 365 licence' },
      { key: 'mailbox_issue', label: 'A mailbox problem' }
    ],
    repairActionKey: 'refresh_signin',
    employeeExplanation:
      'Your account, licence, and mailbox are healthy. The issue appears to be an expired Outlook sign-in session on this computer.',
    followupNeeds: ['platform']
  },
  sharepoint_access: {
    key: 'sharepoint_access',
    label: 'Cannot access SharePoint or a project file',
    platforms: 'any',
    routingCategory: 'Microsoft 365',
    plan: ['Checking your account', 'Checking your group access'],
    checks: [
      { label: 'Checking your account', kind: 'account', read: 'lookup_user' },
      { label: 'Checking your group access', kind: 'm365_service', read: 'check_group_membership' }
    ],
    primaryHypothesis: { key: 'missing_group', label: 'You are not in the group that grants access to that site' },
    competingHypotheses: [
      { key: 'account_issue', label: 'An account problem' },
      { key: 'link_wrong', label: 'The link or file was moved or renamed' }
    ],
    // Group membership changes are an admin action — no employee auto-repair.
    followupNeeds: []
  },
  teams_ipad_av: {
    key: 'teams_ipad_av',
    label: 'Teams camera/microphone not working on iPad',
    platforms: ['ios', 'ipados'],
    routingCategory: 'Apple/MDM',
    plan: ['Checking this device', 'Checking the Teams app'],
    checks: [
      { label: 'Checking this device', kind: 'this_device' },
      { label: 'Checking the Teams app', kind: 'service_health' }
    ],
    primaryHypothesis: { key: 'app_permissions', label: 'Teams is missing camera/microphone permission on the iPad' },
    competingHypotheses: [
      { key: 'broken_install', label: 'A broken Teams install' },
      { key: 'os_restriction', label: 'A device management restriction' }
    ],
    repairActionKey: 'reinstall_app',
    employeeExplanation:
      'The camera and microphone hardware look fine. Teams appears to be missing permission or has a broken install on this iPad.',
    followupNeeds: []
  },
  onedrive_sync: {
    key: 'onedrive_sync',
    label: 'OneDrive is not syncing',
    platforms: ['windows', 'macos'],
    routingCategory: 'Microsoft 365',
    plan: ['Checking your account', 'Checking OneDrive sync'],
    checks: [
      { label: 'Checking your account', kind: 'account', read: 'lookup_user' },
      { label: 'Checking OneDrive sync', kind: 'service_health' }
    ],
    primaryHypothesis: { key: 'sync_stuck', label: 'The OneDrive sync engine is stuck' },
    competingHypotheses: [
      { key: 'storage_full', label: 'The account is out of storage' },
      { key: 'account_issue', label: 'An account problem' }
    ],
    repairActionKey: 'refresh_onedrive',
    employeeExplanation: 'Your account is healthy. OneDrive sync appears to be stuck and can be restarted.',
    followupNeeds: []
  },
  device_slow_storage: {
    key: 'device_slow_storage',
    label: 'Device is slow or low on storage',
    platforms: ['windows', 'macos', 'ios', 'ipados'],
    routingCategory: 'Windows',
    plan: ['Checking this device', 'Checking storage and performance'],
    checks: [
      { label: 'Checking this device', kind: 'this_device' },
      { label: 'Checking storage and performance', kind: 'this_device' }
    ],
    primaryHypothesis: { key: 'needs_restart', label: 'The device needs a restart to clear memory' },
    competingHypotheses: [
      { key: 'low_storage', label: 'The device is low on storage' },
      { key: 'hardware', label: 'A hardware limitation' }
    ],
    repairActionKey: 'restart_device',
    employeeExplanation: 'This device looks reachable but is under memory pressure. A restart is the safe first step.',
    followupNeeds: []
  },
  lost_device: {
    key: 'lost_device',
    label: 'Lost or stolen company device',
    platforms: 'any',
    autoEscalate: 'security',
    routingCategory: 'Security',
    plan: ['Recording the report', 'Notifying the security team'],
    checks: [],
    primaryHypothesis: { key: 'lost_device', label: 'A lost or stolen device requiring security review' },
    competingHypotheses: [],
    followupNeeds: []
  },
  unknown: {
    key: 'unknown',
    label: 'Unrecognised problem',
    platforms: 'any',
    autoEscalate: 'general',
    routingCategory: 'General IT',
    plan: ['Recording the details', 'Passing this to a technician'],
    checks: [],
    primaryHypothesis: { key: 'unknown', label: 'A problem Watson could not classify with confidence' },
    competingHypotheses: [],
    followupNeeds: []
  }
};

// ------------------------------------------------------------
// Deterministic classification. Corrections are handled by the engine (it
// re-classifies the combined statement + latest message).
// ------------------------------------------------------------
// Bluebeam families are merged in from the skill pack so there is exactly one
// source of truth for them. Adding them here is what makes the pack reachable
// from ordinary employee language.
export const SCENARIOS: Record<ScenarioKey, ScenarioDef> = {
  ...BASE_SCENARIOS,
  ...BLUEBEAM_SCENARIO_DEFS
} as Record<ScenarioKey, ScenarioDef>;

export function classifyScenario(text: string): ScenarioKey {
  const t = text.toLowerCase();
  const has = (...ws: string[]) => ws.some((w) => t.includes(w));
  // Whole-word matching for cues that are SUBSTRINGS OF COMMON WORDS.
  // "mic" lives inside "Microsoft", so a plain includes() sent every message
  // mentioning "Microsoft Teams" to the iPad camera/microphone scenario — a
  // Windows performance complaint came back diagnosed as a broken iPad app,
  // with fabricated camera/microphone evidence and "confidence: high", and the
  // wrong summary was written onto the durable case a technician then reads.
  // Short cues must be matched as words, not as fragments.
  const hasWord = (...ws: string[]) =>
    ws.some((w) => new RegExp(`(^|[^a-z0-9])${w}([^a-z0-9]|$)`, 'i').test(t));
  // Bluebeam FIRST. Without this, "Bluebeam is slow" matches the generic `slow`
  // rule below and is misdiagnosed as a Windows storage problem.
  const bb = classifyBluebeamScenarioKey(text);
  if (bb) return bb as ScenarioKey;
  if (has('lost', 'stolen', 'misplaced', "can't find my laptop", 'left my laptop', 'left my phone')) return 'lost_device';
  if (has('outlook') && has('sign in', 'sign-in', 'signin', 'log in', 'login', 'password prompt', 'keeps asking')) return 'outlook_repeated_signin';
  if (has('sharepoint', 'share point', 'project file', 'project folder', 'site access', 'access denied to')) return 'sharepoint_access';
  // 'microphone', 'camera', 'video', 'webcam' are safe as substrings; 'mic' is not.
  if (has('teams') && (has('camera', 'microphone', 'video', 'webcam') || hasWord('mic', 'av'))) return 'teams_ipad_av';
  if (has('onedrive', 'one drive') && has('sync', 'syncing', 'not updating')) return 'onedrive_sync';
  if (has('slow', 'freezing', 'low on storage', 'out of space', 'no space', 'storage full', 'lagging')) return 'device_slow_storage';
  if (has('outlook', 'email', 'mailbox')) return 'outlook_repeated_signin';
  return 'unknown';
}

export function detectPlatform(text: string): Platform {
  const t = text.toLowerCase();
  if (t.includes('ipad')) return 'ipados';
  if (t.includes('iphone')) return 'ios';
  if (t.includes('macbook') || t.includes('mac ') || t.includes('macos') || t.includes('imac')) return 'macos';
  if (t.includes('windows') || t.includes('pc') || t.includes('laptop') || t.includes('desktop')) return 'windows';
  return 'unknown';
}

// Rule-based time estimate for a simulated action, adjusted by device condition.
export function estimateFor(action: SimulatedActionDef, opts: { approvalPending?: boolean } = {}): TimeEstimate {
  let min = action.minMinutes;
  let max = action.maxMinutes;
  if (action.requiresRestart) max += 2;
  if (action.requiresDownload) max += 5;
  const label = `About ${min}–${max} minutes`;
  return { known: true, label, minMinutes: min, maxMinutes: max, ...(opts.approvalPending ? { responseLabel: 'after you approve' } : {}) };
}

export const UNKNOWN_ESTIMATE: TimeEstimate = { known: false, label: 'Unable to estimate until another check completes' };
