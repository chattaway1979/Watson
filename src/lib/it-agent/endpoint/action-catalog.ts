// ============================================================
// Watson — 012 : Registered endpoint action catalogue (Part F item 4 + 10)
// ------------------------------------------------------------
// The complete, versioned set of things a Watson endpoint agent may ever be
// asked to do. Every entry carries its full execution model: prerequisites,
// evidence, expected effect, timeout, success and failure criteria, rollback,
// audit event, and post-action verification.
//
// The language model selects an id from this catalogue. It cannot add to it,
// parameterise it freely, or compose a command — `runtime.ts` refuses anything
// not registered here. That refusal is the security boundary; this file is the
// allowlist it enforces.
//
// Pure data. Nothing here executes; the mock runtime interprets it.
// ============================================================
import type { EndpointTier, ExecutionContext, NavigationStrategy } from './tiers';

export interface EndpointAction {
  readonly id: string;
  readonly version: string;
  readonly label: string;
  readonly tier: EndpointTier;
  readonly context: ExecutionContext;
  readonly strategy: NavigationStrategy;
  // Must all be true before the action may be offered at all.
  readonly prerequisites: readonly string[];
  // Evidence that must already exist on the case to justify running this.
  readonly requiredEvidence: readonly string[];
  readonly expectedEffect: string;
  readonly estimatedSeconds: number;
  readonly employeeImpact: string;
  readonly timeoutSeconds: number;
  readonly successCriteria: readonly string[];
  readonly failureCriteria: readonly string[];
  // Empty rollback is only permissible for non-mutating (Tier 0) actions.
  readonly rollback: string;
  readonly auditEvent: string;
  readonly postVerification: readonly string[];
  // True when the action risks unsaved work and must confirm preservation first.
  readonly touchesUnsavedWork: boolean;
}

const OBSERVE = (o: {
  id: string; label: string; effect: string; audit: string;
  strategy?: NavigationStrategy; context?: ExecutionContext; seconds?: number;
}): EndpointAction => ({
  id: o.id,
  version: '1.0.0',
  label: o.label,
  tier: 0,
  context: o.context ?? 'current_user',
  strategy: o.strategy ?? 'os_management_api',
  prerequisites: ['agent_authenticated', 'device_bound', 'employee_consented'],
  requiredEvidence: [],
  expectedEffect: o.effect,
  estimatedSeconds: o.seconds ?? 3,
  employeeImpact: 'None. Nothing on the computer changes.',
  timeoutSeconds: 20,
  successCriteria: ['A structured result is returned.'],
  failureCriteria: ['Timeout.', 'Access denied.', 'Agent offline.'],
  rollback: 'Not applicable — this action changes nothing.',
  auditEvent: o.audit,
  postVerification: ['Result recorded on the case as evidence.'],
  touchesUnsavedWork: false
});

export const ENDPOINT_ACTIONS: Record<string, EndpointAction> = {
  // ---- Tier 0 — observation ------------------------------------------
  'bluebeam.inspect.process': OBSERVE({
    id: 'bluebeam.inspect.process',
    label: 'Check whether Bluebeam is running and responding',
    effect: 'Returns process presence, responsiveness, CPU and memory use.',
    audit: 'endpoint_inspect_process'
  }),
  'bluebeam.inspect.version': OBSERVE({
    id: 'bluebeam.inspect.version',
    label: 'Check the installed Bluebeam version and edition',
    effect: 'Returns installed version and edition.',
    audit: 'endpoint_inspect_version'
  }),
  'bluebeam.inspect.hung': OBSERVE({
    id: 'bluebeam.inspect.hung',
    label: 'Detect whether Bluebeam is hung',
    effect: 'Returns whether the main window is responding to messages.',
    audit: 'endpoint_detect_hung',
    strategy: 'ui_automation'
  }),
  'bluebeam.inspect.unsavedWork': OBSERVE({
    id: 'bluebeam.inspect.unsavedWork',
    label: 'Check for unsaved markups',
    effect: 'Returns whether any open document has unsaved changes.',
    audit: 'endpoint_inspect_unsaved',
    strategy: 'ui_automation'
  }),
  'bluebeam.inspect.profile': OBSERVE({
    id: 'bluebeam.inspect.profile',
    label: 'Read the active Bluebeam profile and Tool Chest locations',
    effect: 'Returns active profile name and the paths holding recoverable user settings.',
    audit: 'endpoint_inspect_profile'
  }),
  'onedrive.inspect.syncState': OBSERVE({
    id: 'onedrive.inspect.syncState',
    label: 'Check OneDrive sync state',
    effect: 'Returns sync status, pending count, and error state.',
    audit: 'endpoint_inspect_onedrive'
  }),
  'file.inspect.lockState': OBSERVE({
    id: 'file.inspect.lockState',
    label: 'Check read-only, lock, and conflicting-copy state for a file',
    effect: 'Returns read-only flag, lock holder presence, and conflicting-copy presence.',
    audit: 'endpoint_inspect_file_lock'
  }),
  'device.inspect.health': OBSERVE({
    id: 'device.inspect.health',
    label: 'Check operating system, disk, and memory health',
    effect: 'Returns OS build, patch state, free disk, and memory pressure.',
    audit: 'endpoint_inspect_device'
  }),
  'device.inspect.crashLogs': OBSERVE({
    id: 'device.inspect.crashLogs',
    label: 'Collect application crash entries from the event log',
    effect: 'Returns redacted crash entries for the named application.',
    audit: 'endpoint_inspect_crashlogs',
    seconds: 8
  }),

  // ---- Tier 1 — low-risk, reversible ---------------------------------
  'bluebeam.test.knownGoodPdf': {
    id: 'bluebeam.test.knownGoodPdf',
    version: '1.0.0',
    label: 'Open a small known-good PDF to compare',
    tier: 1,
    context: 'current_user',
    strategy: 'command_line',
    prerequisites: ['agent_authenticated', 'device_bound', 'employee_consented', 'bluebeam_installed'],
    requiredEvidence: ['bluebeam.launch.stage'],
    expectedEffect: 'A known-good test PDF opens in Bluebeam.',
    estimatedSeconds: 20,
    employeeImpact: 'A small test drawing opens in a new tab. Nothing you are working on is touched.',
    timeoutSeconds: 90,
    successCriteria: ['The test document renders and is readable.'],
    failureCriteria: ['Bluebeam does not respond within the timeout.', 'The test document also fails to render.'],
    rollback: 'Close the test document tab. No other state changed.',
    auditEvent: 'endpoint_test_known_good_pdf',
    postVerification: ['Record whether the known-good file rendered — this is what separates a file problem from an application problem.'],
    touchesUnsavedWork: false
  },
  'bluebeam.launch': {
    id: 'bluebeam.launch',
    version: '1.0.0',
    label: 'Start Bluebeam',
    tier: 1,
    context: 'current_user',
    strategy: 'command_line',
    prerequisites: ['agent_authenticated', 'device_bound', 'employee_consented', 'bluebeam_installed', 'bluebeam_not_running'],
    requiredEvidence: [],
    expectedEffect: 'Bluebeam starts and reaches an idle main window.',
    estimatedSeconds: 30,
    employeeImpact: 'Bluebeam opens.',
    timeoutSeconds: 120,
    successCriteria: ['Main window present and responding.'],
    failureCriteria: ['Process exits.', 'Window never responds.'],
    rollback: 'Close the application.',
    auditEvent: 'endpoint_launch_application',
    postVerification: ['Confirm the main window responds.'],
    touchesUnsavedWork: false
  },
  'onedrive.retrySync': {
    id: 'onedrive.retrySync',
    version: '1.0.0',
    label: 'Retry a failed OneDrive sync',
    tier: 1,
    context: 'current_user',
    strategy: 'os_management_api',
    prerequisites: ['agent_authenticated', 'device_bound', 'employee_consented'],
    requiredEvidence: ['bluebeam.file.location'],
    expectedEffect: 'OneDrive re-attempts pending uploads and downloads.',
    estimatedSeconds: 30,
    employeeImpact: 'Files may briefly show as syncing.',
    timeoutSeconds: 180,
    successCriteria: ['Pending count decreases or reaches zero.'],
    failureCriteria: ['Sync error persists.', 'Pending count unchanged after the timeout.'],
    rollback: 'None required — retrying a sync does not discard local data.',
    auditEvent: 'endpoint_retry_sync',
    postVerification: ['Re-read sync state and confirm the pending count fell.'],
    touchesUnsavedWork: false
  },

  // ---- Tier 2 — employee approval ------------------------------------
  'bluebeam.process.terminate': {
    id: 'bluebeam.process.terminate',
    version: '1.0.0',
    label: 'End the hung Bluebeam process',
    tier: 2,
    context: 'current_user',
    strategy: 'os_management_api',
    prerequisites: ['agent_authenticated', 'device_bound', 'employee_consented', 'hung_state_confirmed', 'unsaved_work_checked'],
    requiredEvidence: ['bluebeam.hung.confirmed', 'bluebeam.unsavedWork.checked'],
    expectedEffect: 'The unresponsive Bluebeam process ends.',
    estimatedSeconds: 5,
    employeeImpact: 'Bluebeam closes. Any markups not saved will be lost, so this is only offered once unsaved work has been checked.',
    timeoutSeconds: 30,
    successCriteria: ['No Bluebeam process remains.'],
    failureCriteria: ['Process persists after the timeout.'],
    rollback: 'Relaunch Bluebeam. Unsaved markups cannot be recovered — which is exactly why the unsaved-work check is a hard prerequisite.',
    auditEvent: 'endpoint_terminate_process',
    postVerification: ['Confirm the process is gone.', 'Relaunch and confirm the application starts cleanly.'],
    touchesUnsavedWork: true
  },
  'bluebeam.profile.backup': {
    id: 'bluebeam.profile.backup',
    version: '1.0.0',
    label: 'Back up the Bluebeam profile, Tool Chest, and stamps',
    tier: 2,
    context: 'current_user',
    strategy: 'os_management_api',
    prerequisites: ['agent_authenticated', 'device_bound', 'employee_consented'],
    requiredEvidence: ['bluebeam.profile.path'],
    expectedEffect: 'A timestamped copy of the profile, tool sets, stamps, and preferences is written to a protected location.',
    estimatedSeconds: 20,
    employeeImpact: 'None. Nothing is removed; a copy is made.',
    timeoutSeconds: 120,
    successCriteria: ['Backup exists and its manifest lists the expected items.'],
    failureCriteria: ['Backup incomplete.', 'Destination not writable.'],
    rollback: 'Delete the backup copy. The original is untouched.',
    auditEvent: 'endpoint_backup_profile',
    postVerification: ['Verify the backup manifest before any reset is even offered.'],
    touchesUnsavedWork: false
  },
  'bluebeam.profile.switchToTest': {
    id: 'bluebeam.profile.switchToTest',
    version: '1.0.0',
    label: 'Switch to a clean test profile',
    tier: 2,
    context: 'current_user',
    strategy: 'application_api',
    prerequisites: ['agent_authenticated', 'device_bound', 'employee_consented', 'profile_backup_verified'],
    requiredEvidence: ['bluebeam.profile.backupVerified'],
    expectedEffect: 'Bluebeam loads a clean profile, leaving the original in place.',
    estimatedSeconds: 30,
    employeeImpact: 'Your tools and layout will look different while the test profile is active. Nothing of yours is deleted.',
    timeoutSeconds: 120,
    successCriteria: ['Test profile active.', 'Original profile still present on disk.'],
    failureCriteria: ['Profile switch fails.', 'Original profile missing after the switch.'],
    rollback: 'Switch back to the original profile, which was never removed.',
    auditEvent: 'endpoint_switch_profile',
    postVerification: ['Confirm the original profile still exists.', 'Confirm whether the symptom persists under a clean profile — that is the whole point of the test.'],
    touchesUnsavedWork: false
  },
  'bluebeam.profile.restore': {
    id: 'bluebeam.profile.restore',
    version: '1.0.0',
    label: 'Restore the original Bluebeam profile from backup',
    tier: 2,
    context: 'current_user',
    strategy: 'os_management_api',
    prerequisites: ['agent_authenticated', 'device_bound', 'employee_consented', 'profile_backup_verified'],
    requiredEvidence: ['bluebeam.profile.backupVerified'],
    expectedEffect: 'The employee’s original profile, tool sets, and stamps are restored.',
    estimatedSeconds: 30,
    employeeImpact: 'Your own tools and layout come back.',
    timeoutSeconds: 180,
    successCriteria: ['Restored profile active.', 'Tool sets present.'],
    failureCriteria: ['Restore incomplete.', 'Backup unreadable.'],
    rollback: 'Re-apply the test profile; the backup is not consumed by restoring from it.',
    auditEvent: 'endpoint_restore_profile',
    postVerification: ['Confirm the employee recognises their own tool sets on a real drawing.'],
    touchesUnsavedWork: false
  },
  'bluebeam.cache.clearApproved': {
    id: 'bluebeam.cache.clearApproved',
    version: '1.0.0',
    label: 'Clear approved Bluebeam cache locations',
    tier: 2,
    context: 'current_user',
    strategy: 'os_management_api',
    prerequisites: ['agent_authenticated', 'device_bound', 'employee_consented', 'profile_backup_verified', 'bluebeam_not_running'],
    requiredEvidence: ['bluebeam.profile.backupVerified'],
    expectedEffect: 'Only allowlisted cache directories are cleared. Profiles, tool sets, and stamps are never in scope.',
    estimatedSeconds: 20,
    employeeImpact: 'The first launch afterwards may be slower.',
    timeoutSeconds: 120,
    successCriteria: ['Allowlisted cache paths empty.', 'Profile paths untouched.'],
    failureCriteria: ['A non-allowlisted path was in scope — abort.', 'Deletion failed.'],
    rollback: 'Caches regenerate on next launch. Profile data was never touched.',
    auditEvent: 'endpoint_clear_cache',
    postVerification: ['Confirm profile and tool sets still present.'],
    touchesUnsavedWork: false
  },

  // ---- Tier 3 — administrator ----------------------------------------
  'bluebeam.install.repair': {
    id: 'bluebeam.install.repair',
    version: '1.0.0',
    label: 'Run the supported Bluebeam installation repair',
    tier: 3,
    context: 'elevated',
    strategy: 'command_line',
    prerequisites: ['agent_authenticated', 'device_bound', 'administrator_approved', 'profile_backup_verified', 'bluebeam_not_running'],
    requiredEvidence: ['bluebeam.profile.backupVerified', 'bluebeam.knownGoodWorks'],
    expectedEffect: 'The installer repairs the existing installation in place.',
    estimatedSeconds: 600,
    employeeImpact: 'Bluebeam is unavailable for roughly ten minutes.',
    timeoutSeconds: 1800,
    successCriteria: ['Installer reports success.', 'Application launches afterwards.'],
    failureCriteria: ['Installer error.', 'Application fails to launch after repair.'],
    rollback: 'Reinstall the previously deployed version from Intune and restore the profile backup.',
    auditEvent: 'endpoint_repair_install',
    postVerification: ['Launch the application.', 'Confirm the employee’s profile and tool sets survived.'],
    touchesUnsavedWork: false
  }
};

export const ENDPOINT_ACTION_IDS = Object.keys(ENDPOINT_ACTIONS);

export function getEndpointAction(id: string): EndpointAction | null {
  return Object.prototype.hasOwnProperty.call(ENDPOINT_ACTIONS, id) ? ENDPOINT_ACTIONS[id] : null;
}

// Every mutating action must define a real rollback. This is asserted by tests
// rather than trusted, because an action without a rollback is one that cannot
// be safely offered.
export function actionsMissingRollback(): string[] {
  return Object.values(ENDPOINT_ACTIONS)
    .filter((a) => a.tier > 0)
    .filter((a) => !a.rollback || a.rollback.trim().length < 10)
    .map((a) => a.id);
}

// No catalogue entry may be Tier 4: prohibited capability is refused, never
// registered as something merely awaiting approval.
export function actionsAtProhibitedTier(): string[] {
  return Object.values(ENDPOINT_ACTIONS).filter((a) => a.tier === 4).map((a) => a.id);
}
