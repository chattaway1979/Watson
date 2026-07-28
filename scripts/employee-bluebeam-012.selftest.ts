/* ============================================================
 * Watson — 012 : Employee support workflow + Bluebeam skill pack tests
 * Parts A–E. Deterministic; no network, no model call, no device.
 * ============================================================ */
import {
  EMPLOYEE_STATES, toEmployeeState, employeeStateView, decideResolution, instructionsOnlyResolve,
  type EmployeeState
} from '../src/lib/it-agent/support/employee-states';
import {
  CAUSE_PROFILES, causeProfile, mayWatsonAttemptRepair, narrowCause, NON_REPAIRABLE_BY_WATSON,
  type CauseClass
} from '../src/lib/it-agent/support/causes';
import {
  BLUEBEAM_FAMILIES, BLUEBEAM_FAMILY_KEYS, bluebeamFamily, type BluebeamFamilyKey
} from '../src/lib/it-agent/skills/bluebeam/families';
import {
  isBluebeamIntent, classifyBluebeam, nextBestQuestion, hasMinimumEvidence, disambiguationQuestion
} from '../src/lib/it-agent/skills/bluebeam/intents';

export async function runEmployeeBluebeamTests(): Promise<{ pass: number; fail: number; failures: string[] }> {
  let pass = 0, fail = 0;
  const failures: string[] = [];
  const check = (name: string, cond: boolean, detail = '') => {
    if (cond) { pass++; console.log('  ✅ ' + name); }
    else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log('  ❌ ' + name + (detail ? ` — ${detail}` : '')); }
  };

  console.log('\n[60] Employee support states (012)');
  {
    const required: EmployeeState[] = ['ready', 'listening', 'investigation', 'diagnosis', 'approval', 'working',
      'verification', 'resolution', 'escalation', 'open_issue', 'employee_report'];
    check('all eleven employee states are defined', required.every((s) => s in EMPLOYEE_STATES));
    check('only resolution counts as resolved',
      required.filter((s) => EMPLOYEE_STATES[s].countsAsResolved).join(',') === 'resolution');
    check('every state has a plain-language line for the employee',
      required.every((s) => EMPLOYEE_STATES[s].employeeLine.length > 10));
    check('escalation is not treated as resolved', EMPLOYEE_STATES.escalation.countsAsResolved === false);
    check('open issue is not treated as resolved', EMPLOYEE_STATES.open_issue.countsAsResolved === false);

    check('internal waiting_for_approval maps to approval', toEmployeeState('waiting_for_approval') === 'approval');
    check('internal waiting_for_verification maps to verification', toEmployeeState('waiting_for_verification') === 'verification');
    check('internal escalated maps to escalation', toEmployeeState('escalated') === 'escalation');
    check('internal resolved maps to resolution', toEmployeeState('resolved') === 'resolution');
    check('investigating without a cause shows investigation', toEmployeeState('investigating', { hasDiagnosis: false }) === 'investigation');
    check('investigating with a cause shows diagnosis', toEmployeeState('investigating', { hasDiagnosis: true }) === 'diagnosis');
    check('reopened maps to open issue', toEmployeeState('reopened') === 'open_issue');
    check('state view falls back safely', employeeStateView('investigation').label === 'Investigating');

    check('supplying instructions never resolves a case', instructionsOnlyResolve() === false);
  }

  console.log('\n[61] Cause taxonomy and narrowing (012)');
  {
    const all: CauseClass[] = ['user_training', 'application_defect', 'windows_endpoint', 'm365_identity_access',
      'network', 'file_specific', 'permissions', 'service_outage', 'licensing', 'printer_driver', 'unknown_cause'];
    check('all cause classes are profiled', all.every((c) => c in CAUSE_PROFILES));
    check('every cause has an employee-facing summary', all.every((c) => causeProfile(c).employeeSummary.length > 10));
    check('unknown_cause is a first-class outcome', causeProfile('unknown_cause').label === 'Not yet determined');

    check('Watson may not "repair" an identity problem', mayWatsonAttemptRepair('m365_identity_access') === false);
    check('Watson may not "repair" a permissions problem', mayWatsonAttemptRepair('permissions') === false);
    check('Watson may not "repair" a service outage', mayWatsonAttemptRepair('service_outage') === false);
    check('Watson may not "repair" an unknown cause', mayWatsonAttemptRepair('unknown_cause') === false);
    check('Watson may attempt an application defect', mayWatsonAttemptRepair('application_defect') === true);
    check('non-repairable list is explicit', NON_REPAIRABLE_BY_WATSON.length >= 7);

    check('multiple people affected implies an outage',
      narrowCause({ otherPeopleAffected: true }).cause === 'service_outage');
    check('multiple apps affected implies the endpoint',
      narrowCause({ otherAppsAffected: true }).cause === 'windows_endpoint');
    check('known-good works implies a file problem',
      narrowCause({ knownGoodWorks: true }).cause === 'file_specific');
    check('known-good also fails implies the application',
      narrowCause({ knownGoodWorks: false }).cause === 'application_defect');
    check('local copy works implies access or sync',
      narrowCause({ localCopyWorks: true }).cause === 'm365_identity_access');

    const thin = narrowCause({});
    check('no comparison evidence yields unknown_cause', thin.cause === 'unknown_cause');
    check('and is explicitly marked insufficient rather than guessed', thin.sufficient === false);
    check('every sufficient conclusion carries a rationale',
      narrowCause({ knownGoodWorks: true }).rationale.length > 20);
  }

  console.log('\n[62] Bluebeam skill pack — coverage and safety (012)');
  {
    check('all ten Bluebeam issue families exist', BLUEBEAM_FAMILY_KEYS.length === 10, String(BLUEBEAM_FAMILY_KEYS.length));
    const required: BluebeamFamilyKey[] = ['launch_stability', 'signin_licensing', 'studio', 'pdf_rendering',
      'printing_plotting', 'measurement_scale', 'markups_toolchest', 'ocr_search_overlay', 'file_sync_locking', 'profiles_settings'];
    check('every required family is present', required.every((k) => k in BLUEBEAM_FAMILIES));

    for (const k of required) {
      const f = bluebeamFamily(k);
      if (f.minimumEvidence.length === 0) { check(`${k}: minimum evidence defined`, false); continue; }
      if (f.branches.length === 0) { check(`${k}: has diagnostic branches`, false); continue; }
      if (f.verificationSequence.length !== 3) { check(`${k}: three-level verification`, false); continue; }
      if (f.escalationConditions.length === 0) { check(`${k}: escalation conditions`, false); continue; }
      if (f.handoffFields.length === 0) { check(`${k}: handoff fields`, false); continue; }
      if (f.prohibitedActions.length === 0) { check(`${k}: prohibited actions named`, false); continue; }
    }
    check('every family defines minimum evidence', required.every((k) => bluebeamFamily(k).minimumEvidence.length >= 3));
    check('every family verifies at exactly three levels', required.every((k) => bluebeamFamily(k).verificationSequence.length === 3));
    check('every family names prohibited actions', required.every((k) => bluebeamFamily(k).prohibitedActions.length > 0));
    check('every family gives a repair-time range', required.every((k) => {
      const r = bluebeamFamily(k).repairTimeMinutes; return r.min > 0 && r.max >= r.min;
    }));
    check('every family declares a business-impact priority', required.every((k) => !!bluebeamFamily(k).defaultPriority));
    check('every family lists candidate causes including unknown',
      required.every((k) => bluebeamFamily(k).candidateCauses.includes('unknown_cause')));

    // Domain-critical safety rules, stated as tests rather than prose.
    check('measurement family forbids trusting the printed scale label',
      bluebeamFamily('measurement_scale').prohibitedActions.some((p) => /scale label|scale shown/i.test(p)));
    check('markups family forbids reset before Tool Chest backup',
      bluebeamFamily('markups_toolchest').prohibitedActions.some((p) => /backed up|backup/i.test(p)));
    check('profiles family forbids reset before backup',
      bluebeamFamily('profiles_settings').prohibitedActions.some((p) => /backup/i.test(p)));
    check('file sync family forbids deleting conflicting copies',
      bluebeamFamily('file_sync_locking').prohibitedActions.some((p) => /conflicting cop/i.test(p)));
    check('pdf family forbids overwriting the original plan set',
      bluebeamFamily('pdf_rendering').prohibitedActions.some((p) => /overwrit|original/i.test(p)));
    check('printing family forbids flattening the original',
      bluebeamFamily('printing_plotting').prohibitedActions.some((p) => /original/i.test(p)));
    check('licensing family forbids inventing licence status',
      bluebeamFamily('signin_licensing').prohibitedActions.some((p) => /guess|without verified/i.test(p)));
    check('studio family forbids discarding unsynced markups',
      bluebeamFamily('studio').prohibitedActions.some((p) => /unsynced|pending/i.test(p)));
    check('OCR family forbids presenting a limitation as a defect',
      bluebeamFamily('ocr_search_overlay').prohibitedActions.some((p) => /limitation/i.test(p)));
    check('launch family forbids reinstalling before backup',
      bluebeamFamily('launch_stability').prohibitedActions.some((p) => /backup/i.test(p)));
  }

  console.log('\n[63] Bluebeam intent detection and next-best question (012)');
  {
    check('recognises a Bluebeam statement', isBluebeamIntent('Bluebeam will not open.') === true);
    check('recognises Revu', isBluebeamIntent('Revu keeps crashing') === true);
    check('recognises domain vocabulary without the product name', isBluebeamIntent('my tool chest is empty') === true);
    check('does not claim unrelated statements', isBluebeamIntent('Teams keeps asking me to sign in') === false);

    const cases: Array<[string, BluebeamFamilyKey]> = [
      ['Bluebeam will not open.', 'launch_stability'],
      ['Bluebeam is running extremely slow.', 'launch_stability'],
      ['My measurements are wrong.', 'measurement_scale'],
      ['This PDF is blank.', 'pdf_rendering'],
      ['I cannot print this drawing.', 'printing_plotting'],
      ['I cannot join the Studio session.', 'studio'],
      ['My tool chest is empty.', 'markups_toolchest'],
      ['OCR is not working on this scan.', 'ocr_search_overlay'],
      ['The drawing opens read-only.', 'file_sync_locking'],
      ['Bluebeam says my licence is not valid.', 'signin_licensing']
    ];
    for (const [text, expected] of cases) {
      const c = classifyBluebeam(text);
      check(`classifies "${text}" as ${expected}`, c.family === expected, `got ${c.family}`);
    }

    check('returns no family for an unrelated statement', classifyBluebeam('my chair is broken').family === null);

    // One question at a time, never repeated.
    const known: Record<string, unknown> = {};
    const q1 = nextBestQuestion('launch_stability', known);
    check('asks exactly one question first', q1 !== null && typeof q1.question === 'string');
    check('minimum evidence not yet met', hasMinimumEvidence('launch_stability', known) === false);

    known[q1!.evidenceKey] = 'never_opens';
    const q2 = nextBestQuestion('launch_stability', known);
    check('does not repeat an answered question', q2 !== null && q2.evidenceKey !== q1!.evidenceKey);
    check('remaining question count decreases', q2!.remaining < q1!.remaining);

    // Answer everything; then no further questions and evidence is sufficient.
    for (const b of BLUEBEAM_FAMILIES.launch_stability.branches) known[b.evidenceKey] = 'x';
    check('stops asking once every branch is answered', nextBestQuestion('launch_stability', known) === null);
    check('minimum evidence met once all branches answered', hasMinimumEvidence('launch_stability', known) === true);

    // Ambiguity produces a disambiguating question rather than a silent guess.
    const ambiguous = classifyBluebeam('I cannot print and my measurements are wrong');
    check('detects competing families', ambiguous.alternatives.length > 0);
    check('offers a disambiguating question instead of guessing',
      (disambiguationQuestion(ambiguous) ?? '').length > 20);
    check('a clean match needs no disambiguation',
      disambiguationQuestion(classifyBluebeam('My measurements are wrong.')) === null);
  }

  console.log('\n[64] Evidence gate before any repair (012)');
  {
    // The core anti-pattern this slice exists to prevent: proposing a repair
    // from a bare symptom with no comparison evidence.
    const bare = narrowCause({});
    check('a bare symptom yields unknown_cause', bare.cause === 'unknown_cause');
    check('a bare symptom is insufficient for action', bare.sufficient === false);
    check('and unknown_cause blocks Watson-led repair', mayWatsonAttemptRepair(bare.cause) === false);

    const evidenced = narrowCause({ knownGoodWorks: false, otherAppsAffected: false });
    check('evidence unlocks a repairable cause', evidenced.sufficient === true && mayWatsonAttemptRepair(evidenced.cause) === true);

    // Studio/file-sync families deliberately LOWER confidence when unsynced work
    // is present, so pending work blocks progress rather than being a footnote.
    const studioPending = BLUEBEAM_FAMILIES.studio.branches
      .find((b) => b.evidenceKey === 'bluebeam.studio.pendingChanges')!
      .outcomes.find((o) => o.whenAnswer === 'yes')!;
    check('unsynced Studio work lowers confidence', studioPending.confidenceDelta < 0);
    const syncPending = BLUEBEAM_FAMILIES.file_sync_locking.branches
      .find((b) => b.evidenceKey === 'bluebeam.pendingWork')!
      .outcomes.find((o) => o.whenAnswer === 'yes')!;
    check('unsynced file work lowers confidence', syncPending.confidenceDelta < 0);

    // Measurement without a reference dimension must reduce, not raise, confidence.
    const noRef = BLUEBEAM_FAMILIES.measurement_scale.branches
      .find((b) => b.evidenceKey === 'bluebeam.measure.knownDimension')!
      .outcomes.find((o) => o.whenAnswer === 'no')!;
    check('no reference dimension lowers measurement confidence', noRef.confidenceDelta < 0);
  }

  return { pass, fail, failures };
}
