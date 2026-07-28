// ============================================================
// Watson — 012 : Endpoint session, policy enforcement, and MOCK execution
// ------------------------------------------------------------
// This is the enforcement point. Everything a future signed agent would be
// asked to do passes through `executeAction`, which refuses anything that is
// not a registered catalogue entry, above the session's tier ceiling, missing a
// prerequisite, missing approval, or attempted after the employee pressed Stop.
//
// NOTHING HERE TOUCHES A REAL DEVICE. `MockDevice` is an in-memory fixture. The
// point of building enforcement now is that the rules are proven by tests long
// before an agent exists to obey them — the alternative is discovering the
// gaps once the agent is already installed on someone's computer.
// ============================================================
import {
  ENDPOINT_TIERS, isProhibited, maxTierForMode, PROHIBITED_CAPABILITIES,
  type EndpointTier, type OperatingMode
} from './tiers';
import { getEndpointAction, type EndpointAction } from './action-catalog';

// ------------------------------------------------------------
// Employee consent (Part F item 6). Watson must never silently take control.
// ------------------------------------------------------------
export interface ConsentDisclosure {
  readonly whatWillBeInspected: readonly string[];
  readonly observeOnly: boolean;
  readonly mayChangeThings: boolean;
  readonly expectedDurationLabel: string;
  readonly applicationsMayClose: boolean;
  readonly unsavedWorkMayBeAffected: boolean;
  readonly howToStop: string;
}

export interface EndpointSession {
  readonly sessionId: string;
  readonly deviceAlias: string;      // redacted alias, never a device name
  readonly employeeAlias: string;    // redacted alias, never an email
  readonly mode: OperatingMode;
  readonly disclosure: ConsentDisclosure;
  consented: boolean;
  stopped: boolean;
  stopReason: string | null;
  // Visible indicator must be shown for the whole session.
  indicatorVisible: boolean;
  readonly actionsRun: string[];
  readonly auditTrail: Array<{ event: string; actionId?: string; outcome: string }>;
}

export interface BeginSessionOpts {
  sessionId: string;
  deviceAlias: string;
  employeeAlias: string;
  mode: OperatingMode;
  plannedActionIds: readonly string[];
}

export type BeginSessionResult =
  | { ok: true; session: EndpointSession }
  | { ok: false; refused: true; reason: string };

// Build the disclosure from the actions actually planned, so what the employee
// is told matches what will really happen rather than a generic notice.
export function buildDisclosure(plannedActionIds: readonly string[]): ConsentDisclosure {
  const actions = plannedActionIds.map(getEndpointAction).filter((a): a is EndpointAction => a !== null);
  const mutating = actions.filter((a) => ENDPOINT_TIERS[a.tier].mutatesDevice);
  const totalSeconds = actions.reduce((n, a) => n + a.estimatedSeconds, 0);
  const mins = Math.max(1, Math.round(totalSeconds / 60));
  return {
    whatWillBeInspected: actions.map((a) => a.label),
    observeOnly: mutating.length === 0,
    mayChangeThings: mutating.length > 0,
    expectedDurationLabel: `About ${mins} minute${mins === 1 ? '' : 's'}`,
    applicationsMayClose: actions.some((a) => a.id.includes('terminate') || a.id.includes('repair')),
    unsavedWorkMayBeAffected: actions.some((a) => a.touchesUnsavedWork),
    howToStop: 'Press "Stop Watson" at any time. Watson stops immediately and runs nothing further.'
  };
}

export function beginSession(opts: BeginSessionOpts): BeginSessionResult {
  // Refuse the whole session if any planned action is unregistered — an
  // unknown id means something composed a request rather than selecting one.
  const unknown = opts.plannedActionIds.filter((id) => getEndpointAction(id) === null);
  if (unknown.length > 0) {
    return { ok: false, refused: true, reason: `unregistered_action:${unknown[0]}` };
  }
  const ceiling = maxTierForMode(opts.mode);
  const tooHigh = opts.plannedActionIds
    .map(getEndpointAction)
    .filter((a): a is EndpointAction => a !== null)
    .filter((a) => a.tier > ceiling);
  if (tooHigh.length > 0) {
    return { ok: false, refused: true, reason: `action_above_mode_ceiling:${tooHigh[0].id}` };
  }

  const disclosure = buildDisclosure(opts.plannedActionIds);
  return {
    ok: true,
    session: {
      sessionId: opts.sessionId,
      deviceAlias: opts.deviceAlias,
      employeeAlias: opts.employeeAlias,
      mode: opts.mode,
      disclosure,
      consented: false,
      stopped: false,
      stopReason: null,
      indicatorVisible: true,
      actionsRun: [],
      auditTrail: [{ event: 'session_opened', outcome: 'awaiting_consent' }]
    }
  };
}

export function grantConsent(session: EndpointSession): EndpointSession {
  session.consented = true;
  session.auditTrail.push({ event: 'employee_consent_granted', outcome: 'ok' });
  return session;
}

// One-click stop. Takes effect immediately and is irreversible for the session.
export function stopSession(session: EndpointSession, reason = 'employee_stopped'): EndpointSession {
  session.stopped = true;
  session.stopReason = reason;
  session.indicatorVisible = false;
  session.auditTrail.push({ event: 'session_stopped', outcome: reason });
  return session;
}

// ------------------------------------------------------------
// Mock device state
// ------------------------------------------------------------
export interface MockDevice {
  bluebeamInstalled: boolean;
  bluebeamVersion: string;
  bluebeamEdition: string;
  bluebeamRunning: boolean;
  bluebeamHung: boolean;
  unsavedWork: boolean;
  profileName: string;
  profileBackedUp: boolean;
  testProfileActive: boolean;
  knownGoodPdfRenders: boolean;
  targetPdfRenders: boolean;
  oneDrivePending: number;
  oneDriveError: boolean;
  fileReadOnly: boolean;
  fileLockedByOther: boolean;
  conflictingCopy: boolean;
  freeDiskGb: number;
  memoryPressure: 'normal' | 'high';
}

export function defaultMockDevice(over: Partial<MockDevice> = {}): MockDevice {
  return {
    bluebeamInstalled: true,
    bluebeamVersion: '21.0.40',
    bluebeamEdition: 'Revu Complete',
    bluebeamRunning: true,
    bluebeamHung: false,
    unsavedWork: false,
    profileName: 'HR-Electric-Estimating',
    profileBackedUp: false,
    testProfileActive: false,
    knownGoodPdfRenders: true,
    targetPdfRenders: true,
    oneDrivePending: 0,
    oneDriveError: false,
    fileReadOnly: false,
    fileLockedByOther: false,
    conflictingCopy: false,
    freeDiskGb: 120,
    memoryPressure: 'normal',
    ...over
  };
}

// ------------------------------------------------------------
// Execution
// ------------------------------------------------------------
export interface ExecuteOpts {
  approvals?: { employee?: boolean; administrator?: boolean };
  // Facts already established on the case; prerequisites are checked against it.
  established?: Record<string, unknown>;
}

export type EndpointResult =
  | { ok: true; actionId: string; data: Record<string, unknown>; auditEvent: string; verification: readonly string[] }
  | { ok: false; refused: true; actionId: string; reason: string };

const refuse = (actionId: string, reason: string): EndpointResult =>
  ({ ok: false, refused: true, actionId, reason });

export function executeAction(
  session: EndpointSession,
  actionId: string,
  device: MockDevice,
  opts: ExecuteOpts = {}
): EndpointResult {
  // 1) Stop beats everything, including work already authorised.
  if (session.stopped) {
    session.auditTrail.push({ event: 'action_refused', actionId, outcome: 'session_stopped' });
    return refuse(actionId, 'session_stopped');
  }

  // 2) Only registered actions exist. A model-composed command lands here.
  const action = getEndpointAction(actionId);
  if (!action) {
    session.auditTrail.push({ event: 'action_refused', actionId, outcome: 'unregistered_action' });
    return refuse(actionId, 'unregistered_action');
  }

  // 3) Prohibited tier is refused outright, never queued for approval.
  if (isProhibited(action.tier)) {
    session.auditTrail.push({ event: 'action_refused', actionId, outcome: 'prohibited_tier' });
    return refuse(actionId, 'prohibited_tier');
  }

  // 4) Consent must precede anything, including observation.
  if (!session.consented) {
    session.auditTrail.push({ event: 'action_refused', actionId, outcome: 'consent_missing' });
    return refuse(actionId, 'consent_missing');
  }

  // 5) Mode ceiling.
  if (action.tier > maxTierForMode(session.mode)) {
    session.auditTrail.push({ event: 'action_refused', actionId, outcome: 'above_mode_ceiling' });
    return refuse(actionId, 'above_mode_ceiling');
  }

  // 6) Approval authority.
  const approval = ENDPOINT_TIERS[action.tier].approval;
  if (approval === 'employee' && !opts.approvals?.employee) {
    session.auditTrail.push({ event: 'action_refused', actionId, outcome: 'employee_approval_required' });
    return refuse(actionId, 'employee_approval_required');
  }
  if (approval === 'administrator' && !opts.approvals?.administrator) {
    session.auditTrail.push({ event: 'action_refused', actionId, outcome: 'administrator_approval_required' });
    return refuse(actionId, 'administrator_approval_required');
  }

  // 7) Unsaved-work guard. An action that can destroy markups may not run until
  //    the check has actually been performed — not merely assumed safe.
  if (action.touchesUnsavedWork) {
    const checked = opts.established?.['bluebeam.unsavedWork.checked'];
    if (checked !== true) {
      session.auditTrail.push({ event: 'action_refused', actionId, outcome: 'unsaved_work_not_checked' });
      return refuse(actionId, 'unsaved_work_not_checked');
    }
    if (device.unsavedWork) {
      session.auditTrail.push({ event: 'action_refused', actionId, outcome: 'unsaved_work_present' });
      return refuse(actionId, 'unsaved_work_present');
    }
  }

  // 8) Explicit evidence prerequisites.
  const missing = action.requiredEvidence.filter((k) => !(k in (opts.established ?? {})));
  if (missing.length > 0) {
    session.auditTrail.push({ event: 'action_refused', actionId, outcome: `missing_evidence:${missing[0]}` });
    return refuse(actionId, `missing_evidence:${missing[0]}`);
  }

  // 9) Mutating actions require a real rollback path.
  if (ENDPOINT_TIERS[action.tier].requiresRollback && action.rollback.trim().length < 10) {
    session.auditTrail.push({ event: 'action_refused', actionId, outcome: 'no_rollback_path' });
    return refuse(actionId, 'no_rollback_path');
  }

  const data = simulate(action, device);
  session.actionsRun.push(actionId);
  session.auditTrail.push({ event: action.auditEvent, actionId, outcome: 'ok' });
  return { ok: true, actionId, data, auditEvent: action.auditEvent, verification: action.postVerification };
}

// Deterministic mock effects. Mutating actions change MockDevice so that
// post-action verification in tests is real rather than asserted.
function simulate(action: EndpointAction, d: MockDevice): Record<string, unknown> {
  switch (action.id) {
    case 'bluebeam.inspect.process':
      return { installed: d.bluebeamInstalled, running: d.bluebeamRunning, responding: !d.bluebeamHung };
    case 'bluebeam.inspect.version':
      return { version: d.bluebeamVersion, edition: d.bluebeamEdition };
    case 'bluebeam.inspect.hung':
      return { hung: d.bluebeamHung };
    case 'bluebeam.inspect.unsavedWork':
      return { unsavedWork: d.unsavedWork, checked: true };
    case 'bluebeam.inspect.profile':
      return { profileName: d.profileName, testProfileActive: d.testProfileActive, backedUp: d.profileBackedUp };
    case 'onedrive.inspect.syncState':
      return { pending: d.oneDrivePending, error: d.oneDriveError };
    case 'file.inspect.lockState':
      return { readOnly: d.fileReadOnly, lockedByOther: d.fileLockedByOther, conflictingCopy: d.conflictingCopy };
    case 'device.inspect.health':
      return { freeDiskGb: d.freeDiskGb, memoryPressure: d.memoryPressure };
    case 'device.inspect.crashLogs':
      return { entries: d.bluebeamHung ? 1 : 0, redacted: true };

    case 'bluebeam.test.knownGoodPdf': {
      // The discriminator: known-good renders while the target does not.
      const fileSpecific = d.knownGoodPdfRenders && !d.targetPdfRenders;
      return { knownGoodRenders: d.knownGoodPdfRenders, fileSpecific };
    }
    case 'bluebeam.launch':
      d.bluebeamRunning = true; d.bluebeamHung = false;
      return { running: true };
    case 'onedrive.retrySync':
      d.oneDrivePending = 0; d.oneDriveError = false;
      return { pending: 0, error: false };

    case 'bluebeam.process.terminate':
      d.bluebeamRunning = false; d.bluebeamHung = false;
      return { running: false };
    case 'bluebeam.profile.backup':
      d.profileBackedUp = true;
      return { backedUp: true, manifest: ['profile', 'toolchest', 'stamps', 'preferences'] };
    case 'bluebeam.profile.switchToTest':
      d.testProfileActive = true;
      return { testProfileActive: true, originalPreserved: d.profileBackedUp };
    case 'bluebeam.profile.restore':
      d.testProfileActive = false;
      return { testProfileActive: false, restored: true, profileName: d.profileName };
    case 'bluebeam.cache.clearApproved':
      return { cleared: true, profileTouched: false };
    case 'bluebeam.install.repair':
      d.bluebeamRunning = false;
      return { repaired: true };
    default:
      return {};
  }
}

// ------------------------------------------------------------
// Model-output guard.
//
// The catalogue is the allowlist; this is what a caller uses to check a
// model-proposed action BEFORE it reaches the session. Anything resembling a
// raw command is rejected on shape alone, so a prompt-injected instruction
// cannot become an executed command.
// ------------------------------------------------------------
const COMMAND_SHAPED = /(^|[\s;|&])(powershell|pwsh|cmd|cmd\.exe|reg|regedit|sc|net|wmic|bash|sh|curl|wget|rm|del|format|schtasks)\b|[;|&><`$]/i;

export function isModelProposalAcceptable(proposed: string): { ok: boolean; reason?: string } {
  if (typeof proposed !== 'string' || proposed.trim().length === 0) {
    return { ok: false, reason: 'empty_proposal' };
  }
  if (COMMAND_SHAPED.test(proposed)) {
    return { ok: false, reason: 'command_shaped_input' };
  }
  if (getEndpointAction(proposed) === null) {
    return { ok: false, reason: 'unregistered_action' };
  }
  return { ok: true };
}

export function prohibitedCapabilityNames(): readonly string[] {
  return PROHIBITED_CAPABILITIES;
}

export function tierCeilingFor(mode: OperatingMode): EndpointTier {
  return maxTierForMode(mode);
}
