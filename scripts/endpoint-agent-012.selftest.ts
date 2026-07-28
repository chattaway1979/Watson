/* ============================================================
 * Watson — 012 : Endpoint agent mock tests (Part F item 10)
 *
 * NO real device, NO network, NO shell. `MockDevice` is an in-memory fixture
 * and every "action" is interpreted by the mock runtime. These tests exist to
 * prove the permission model refuses the right things BEFORE any agent is
 * built — the refusals matter more than the successes.
 * ============================================================ */
import {
  beginSession, grantConsent, stopSession, executeAction, defaultMockDevice,
  isModelProposalAcceptable, buildDisclosure, tierCeilingFor,
  type EndpointSession, type MockDevice
} from '../src/lib/it-agent/endpoint/runtime';
import {
  ENDPOINT_ACTIONS, getEndpointAction, actionsMissingRollback, actionsAtProhibitedTier
} from '../src/lib/it-agent/endpoint/action-catalog';
import {
  ENDPOINT_TIERS, OPERATING_MODES, isProhibited, isDowngradedStrategy, navigationRank,
  PROHIBITED_CAPABILITIES
} from '../src/lib/it-agent/endpoint/tiers';
import {
  buildHandoff, assessHandoffCompleteness, renderHandoff, redactForHandoff, type HandoffRecord
} from '../src/lib/it-agent/support/handoff';
import { decideResolution } from '../src/lib/it-agent/support/employee-states';

function session(mode: 'guided' | 'assisted_control' | 'autonomous_remediation', planned: string[]): EndpointSession {
  const r = beginSession({
    sessionId: 's1', deviceAlias: 'DEV-A1', employeeAlias: 'T1', mode, plannedActionIds: planned
  });
  if (!r.ok) throw new Error('session refused: ' + r.reason);
  return grantConsent(r.session);
}

export async function runEndpointAgentTests(): Promise<{ pass: number; fail: number; failures: string[] }> {
  let pass = 0, fail = 0;
  const failures: string[] = [];
  const check = (name: string, cond: boolean, detail = '') => {
    if (cond) { pass++; console.log('  ✅ ' + name); }
    else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log('  ❌ ' + name + (detail ? ` — ${detail}` : '')); }
  };

  console.log('\n[55] Endpoint agent — catalogue integrity (012)');
  {
    check('every mutating action defines a rollback path', actionsMissingRollback().length === 0, actionsMissingRollback().join(','));
    check('no catalogue entry is registered at the prohibited tier', actionsAtProhibitedTier().length === 0);
    check('catalogue is non-trivial', Object.keys(ENDPOINT_ACTIONS).length >= 15, String(Object.keys(ENDPOINT_ACTIONS).length));
    check('every action declares success and failure criteria',
      Object.values(ENDPOINT_ACTIONS).every((a) => a.successCriteria.length > 0 && a.failureCriteria.length > 0));
    check('every action declares post-action verification',
      Object.values(ENDPOINT_ACTIONS).every((a) => a.postVerification.length > 0));
    check('every action is versioned', Object.values(ENDPOINT_ACTIONS).every((a) => /^\d+\.\d+\.\d+$/.test(a.version)));
    check('tier 0 actions never mutate the device',
      Object.values(ENDPOINT_ACTIONS).filter((a) => a.tier === 0).every((a) => !ENDPOINT_TIERS[a.tier].mutatesDevice));
    check('prohibited capabilities are enumerated', PROHIBITED_CAPABILITIES.length >= 10);
    check('tier 4 is prohibited, not merely approval-gated', isProhibited(4) && ENDPOINT_TIERS[4].approval === 'separate_workflow');
    check('autonomous mode is NARROWER than assisted mode',
      OPERATING_MODES.autonomous_remediation.maxTier < OPERATING_MODES.assisted_control.maxTier);
    check('autonomous mode requires assisted mode proven first',
      OPERATING_MODES.autonomous_remediation.requiresPriorModeProven === 'assisted_control');
    check('coordinate clicking ranks last among navigation strategies',
      navigationRank('visual_fallback') > navigationRank('ui_automation') &&
      navigationRank('application_api') === 0);
    check('using visual fallback when an API exists is flagged as downgraded',
      isDowngradedStrategy('visual_fallback', ['application_api', 'visual_fallback']));
  }

  console.log('\n[56] Endpoint agent — consent and stop (012)');
  {
    const d = buildDisclosure(['bluebeam.inspect.process', 'bluebeam.process.terminate']);
    check('disclosure names what will be inspected', d.whatWillBeInspected.length === 2);
    check('disclosure admits changes will be made', d.mayChangeThings === true && d.observeOnly === false);
    check('disclosure warns applications may close', d.applicationsMayClose === true);
    check('disclosure warns unsaved work may be affected', d.unsavedWorkMayBeAffected === true);
    check('disclosure states how to stop', /Stop Watson/i.test(d.howToStop));
    check('disclosure gives an expected duration', /minute/.test(d.expectedDurationLabel));

    const observeOnly = buildDisclosure(['bluebeam.inspect.process', 'bluebeam.inspect.version']);
    check('observe-only session is declared observe-only', observeOnly.observeOnly === true && observeOnly.mayChangeThings === false);

    // Consent must precede even observation.
    const r = beginSession({ sessionId: 's', deviceAlias: 'D', employeeAlias: 'T1', mode: 'guided', plannedActionIds: ['bluebeam.inspect.process'] });
    const s = r.ok ? r.session : null;
    const beforeConsent = s ? executeAction(s, 'bluebeam.inspect.process', defaultMockDevice()) : null;
    check('nothing runs before consent, not even observation',
      beforeConsent !== null && beforeConsent.ok === false && beforeConsent.reason === 'consent_missing');

    // Stop is immediate and beats prior authorisation.
    const s2 = session('assisted_control', ['bluebeam.inspect.process']);
    stopSession(s2);
    const afterStop = executeAction(s2, 'bluebeam.inspect.process', defaultMockDevice());
    check('employee Stop halts everything immediately',
      afterStop.ok === false && afterStop.reason === 'session_stopped');
    check('Stop clears the visible indicator', s2.indicatorVisible === false);
    check('Stop is recorded in the audit trail', s2.auditTrail.some((e) => e.event === 'session_stopped'));
    check('visible indicator is on while a session is live', session('guided', ['bluebeam.inspect.process']).indicatorVisible === true);
  }

  console.log('\n[57] Endpoint agent — refusals (012)');
  {
    const s = session('assisted_control', ['bluebeam.inspect.process']);
    const d = defaultMockDevice();

    // Unregistered / model-composed commands.
    check('refuses an unregistered action id', executeAction(s, 'bluebeam.doWhatever', d).ok === false);
    check('refuses a raw PowerShell command', isModelProposalAcceptable('powershell -c "Remove-Item C:\\\\x"').ok === false);
    check('refuses a shell command with a pipe', isModelProposalAcceptable('tasklist | findstr revu').ok === false);
    check('refuses a registry command', isModelProposalAcceptable('reg delete HKLM\\Software').ok === false);
    check('refuses an empty proposal', isModelProposalAcceptable('').ok === false);
    check('refuses an unknown but harmless-looking id', isModelProposalAcceptable('bluebeam.fixEverything').ok === false);
    check('accepts a registered catalogue id', isModelProposalAcceptable('bluebeam.inspect.process').ok === true);

    // Tier ceilings.
    const guided = session('guided', ['bluebeam.inspect.process']);
    const aboveCeiling = executeAction(guided, 'bluebeam.process.terminate', d, { approvals: { employee: true }, established: { 'bluebeam.hung.confirmed': true, 'bluebeam.unsavedWork.checked': true } });
    check('refuses an action above the mode ceiling',
      aboveCeiling.ok === false && aboveCeiling.reason === 'above_mode_ceiling');
    check('guided mode ceiling is observation only', tierCeilingFor('guided') === 0);

    // Administrator tier cannot be self-approved by the employee.
    const assisted = beginSession({ sessionId: 'x', deviceAlias: 'D', employeeAlias: 'T1', mode: 'assisted_control', plannedActionIds: ['bluebeam.install.repair'] });
    check('a session planning an admin action is refused at assisted ceiling',
      assisted.ok === false && String(assisted.ok === false && assisted.reason).includes('above_mode_ceiling'));

    // Approval gates.
    const noApproval = executeAction(s, 'bluebeam.profile.backup', d, { established: { 'bluebeam.profile.path': 'x' } });
    check('tier 2 refuses without employee approval',
      noApproval.ok === false && noApproval.reason === 'employee_approval_required');

    // Evidence prerequisites.
    const noEvidence = executeAction(s, 'bluebeam.profile.switchToTest', d, { approvals: { employee: true } });
    check('refuses when required evidence is missing',
      noEvidence.ok === false && String(noEvidence.ok === false && noEvidence.reason).startsWith('missing_evidence'));
  }

  console.log('\n[58] Endpoint agent — Bluebeam inspection and repair flow (012)');
  {
    // --- inspect process / version / hung ---
    const hungDevice = defaultMockDevice({ bluebeamHung: true, unsavedWork: false });
    const s = session('assisted_control', ['bluebeam.inspect.process']);
    const proc = executeAction(s, 'bluebeam.inspect.process', hungDevice);
    check('inspects Bluebeam process state', proc.ok === true && proc.data.running === true && proc.data.responding === false);
    const ver = executeAction(s, 'bluebeam.inspect.version', hungDevice);
    check('inspects Bluebeam version and edition', ver.ok === true && ver.data.version === '21.0.40' && ver.data.edition === 'Revu Complete');
    const hung = executeAction(s, 'bluebeam.inspect.hung', hungDevice);
    check('detects a hung Bluebeam process', hung.ok === true && hung.data.hung === true);

    // --- unsaved-work protection ---
    const withUnsaved = defaultMockDevice({ bluebeamHung: true, unsavedWork: true });
    const notChecked = executeAction(s, 'bluebeam.process.terminate', withUnsaved, { approvals: { employee: true }, established: { 'bluebeam.hung.confirmed': true } });
    check('refuses to terminate before the unsaved-work check has run',
      notChecked.ok === false && notChecked.reason === 'unsaved_work_not_checked');

    const unsavedProbe = executeAction(s, 'bluebeam.inspect.unsavedWork', withUnsaved);
    check('unsaved-work probe reports pending markups', unsavedProbe.ok === true && unsavedProbe.data.unsavedWork === true);

    const blocked = executeAction(s, 'bluebeam.process.terminate', withUnsaved, {
      approvals: { employee: true },
      established: { 'bluebeam.hung.confirmed': true, 'bluebeam.unsavedWork.checked': true }
    });
    check('refuses to terminate while unsaved markups exist',
      blocked.ok === false && blocked.reason === 'unsaved_work_present');

    // --- restart after approval, once safe ---
    const term = executeAction(s, 'bluebeam.process.terminate', hungDevice, {
      approvals: { employee: true },
      established: { 'bluebeam.hung.confirmed': true, 'bluebeam.unsavedWork.checked': true }
    });
    check('terminates the hung process after approval when no work is at risk', term.ok === true && hungDevice.bluebeamRunning === false);
    const relaunch = executeAction(s, 'bluebeam.launch', hungDevice);
    check('restarts Bluebeam after approval', relaunch.ok === true && hungDevice.bluebeamRunning === true);
    check('symptom removal is verifiable from device state', hungDevice.bluebeamHung === false);

    // --- known-good PDF: file-specific vs application-wide ---
    const fileBad = defaultMockDevice({ knownGoodPdfRenders: true, targetPdfRenders: false });
    const t1 = executeAction(s, 'bluebeam.test.knownGoodPdf', fileBad, { established: { 'bluebeam.launch.stage': 'opens_then_freezes' } });
    check('tests a known-good PDF', t1.ok === true && t1.data.knownGoodRenders === true);
    check('identifies a FILE-SPECIFIC failure', t1.ok === true && t1.data.fileSpecific === true);

    const appBad = defaultMockDevice({ knownGoodPdfRenders: false, targetPdfRenders: false });
    const t2 = executeAction(s, 'bluebeam.test.knownGoodPdf', appBad, { established: { 'bluebeam.launch.stage': 'never_opens' } });
    check('identifies an APPLICATION-WIDE failure', t2.ok === true && t2.data.fileSpecific === false);

    // --- OneDrive sync and file lock ---
    const synced = defaultMockDevice({ oneDrivePending: 3, oneDriveError: true, fileReadOnly: true, fileLockedByOther: true, conflictingCopy: true });
    const sync = executeAction(s, 'onedrive.inspect.syncState', synced);
    check('inspects OneDrive sync state', sync.ok === true && sync.data.pending === 3 && sync.data.error === true);
    const lock = executeAction(s, 'file.inspect.lockState', synced);
    check('inspects read-only, lock, and conflicting-copy state',
      lock.ok === true && lock.data.readOnly === true && lock.data.lockedByOther === true && lock.data.conflictingCopy === true);

    // --- profile backup / switch / restore ---
    const pd = defaultMockDevice();
    const noBackupYet = executeAction(s, 'bluebeam.profile.switchToTest', pd, { approvals: { employee: true } });
    check('refuses a profile switch before a verified backup exists',
      noBackupYet.ok === false && String(noBackupYet.ok === false && noBackupYet.reason).startsWith('missing_evidence'));

    const backup = executeAction(s, 'bluebeam.profile.backup', pd, { approvals: { employee: true }, established: { 'bluebeam.profile.path': 'p' } });
    check('backs up the Bluebeam profile, Tool Chest and stamps',
      backup.ok === true && pd.profileBackedUp === true &&
      Array.isArray(backup.data.manifest) && (backup.data.manifest as string[]).includes('toolchest'));

    const sw = executeAction(s, 'bluebeam.profile.switchToTest', pd, { approvals: { employee: true }, established: { 'bluebeam.profile.backupVerified': true } });
    check('switches to a clean test profile', sw.ok === true && pd.testProfileActive === true);
    check('original profile is preserved through the switch', sw.ok === true && sw.data.originalPreserved === true);

    const rs = executeAction(s, 'bluebeam.profile.restore', pd, { approvals: { employee: true }, established: { 'bluebeam.profile.backupVerified': true } });
    check('restores the original profile', rs.ok === true && pd.testProfileActive === false && rs.data.profileName === 'HR-Electric-Estimating');

    // Cache clear must never touch profile data.
    const cc = executeAction(s, 'bluebeam.cache.clearApproved', pd, { approvals: { employee: true }, established: { 'bluebeam.profile.backupVerified': true } });
    check('cache clear leaves profile data untouched', cc.ok === true && cc.data.profileTouched === false);
  }

  console.log('\n[59] Endpoint agent — verification and escalation (012)');
  {
    // Three-level verification: action, symptom, workflow.
    check('action completed but workflow not restored is NOT resolved',
      decideResolution({ actionCompleted: true, symptomRemoved: true, workflowRestored: false, confirmedByEmployee: true }).resolved === false);
    check('unrestored workflow is parked as an open issue',
      decideResolution({ actionCompleted: true, symptomRemoved: true, workflowRestored: false, confirmedByEmployee: true }).state === 'open_issue');
    check('symptom still present is NOT resolved',
      decideResolution({ actionCompleted: true, symptomRemoved: false, workflowRestored: false, confirmedByEmployee: true }).resolved === false);
    check('unconfirmed by employee stays in verification',
      decideResolution({ actionCompleted: true, symptomRemoved: true, workflowRestored: true, confirmedByEmployee: false }).state === 'verification');
    check('all three levels plus employee confirmation resolves',
      decideResolution({ actionCompleted: true, symptomRemoved: true, workflowRestored: true, confirmedByEmployee: true }).resolved === true);

    // Complete handoff when repair fails.
    const record: HandoffRecord = {
      caseShortId: 'WAT-0042',
      employeeReportedSymptom: 'Bluebeam crashes opening the riser diagram, contact sarah.example@hrelectriccompany.com',
      affectedWorkflow: 'Cannot complete the panel schedule takeoff due Friday',
      businessImpact: 'team', priority: 'high',
      device: { label: 'Estimating laptop', os: 'Windows 11 23H2', managed: true },
      applicationVersion: '21.0.40', applicationEdition: 'Revu Complete',
      fileSpecificVsApplicationWide: 'application_wide',
      knownGoodComparison: 'known_good_also_fails',
      reproducesOnOtherDevice: false,
      localVsSynced: 'both_fail',
      syncState: 'up to date', lockState: 'not locked', unsavedWorkPresent: false,
      suspectedCause: 'application_defect', confidence: 'moderate',
      ruledOut: [
        { cause: 'file_specific', becauseOf: 'a known-good PDF also fails' },
        { cause: 'network', becauseOf: 'a local copy fails identically' }
      ],
      actionsAttempted: [
        { action: 'Ended hung process and relaunched', outcome: 'crash recurred' },
        { action: 'Clean test profile', outcome: 'crash recurred under a clean profile' }
      ],
      stillUnknown: ['Whether a recent update introduced this'],
      escalationReason: 'Crash persists under a clean profile, so this is beyond safe employee-level repair.',
      suggestedNextSteps: ['Review crash logs', 'Consider a repair install with the profile backup in place'],
      routingQueue: 'desktop_support'
    };
    const h = buildHandoff(record);
    const completeness = assessHandoffCompleteness(h);
    check('handoff is complete when repair fails', completeness.complete === true, completeness.missing.join(','));
    check('handoff redacts employee addresses', !/@hrelectriccompany\.com/.test(h.employeeReportedSymptom));
    check('handoff records what was RULED OUT', h.ruledOut.length === 2);
    check('handoff records failed attempts, not just successes',
      h.actionsAttempted.some((a) => /recurred/.test(a.outcome)));
    check('handoff records what is still unknown', h.stillUnknown.length > 0);

    const rendered = renderHandoff(h);
    check('rendered handoff names the blocked workflow', /panel schedule takeoff/.test(rendered));
    check('rendered handoff states why it escalated', /Why escalated:/.test(rendered));
    check('rendered handoff contains no raw email address', !/@hrelectriccompany\.com/.test(rendered));

    const incomplete = assessHandoffCompleteness({ caseShortId: 'X' });
    check('incomplete handoff is detected rather than shipped', incomplete.complete === false && incomplete.missing.length > 5);

    check('redaction covers GUIDs and tokens',
      redactForHandoff('id 3f2504e0-4f89-11d3-9a0c-0305e82c3301 tok eyJabcdefghijk') === 'id [id] tok [token]');
  }

  return { pass, fail, failures };
}
