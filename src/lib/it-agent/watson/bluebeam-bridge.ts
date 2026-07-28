// ============================================================
// Watson — 013 : Bluebeam skill pack → case engine bridge
// ------------------------------------------------------------
// THE GAP THIS CLOSES
// Before 013, `classifyScenario()` had no Bluebeam matchers. "Bluebeam will not
// open" fell through to the `unknown` scenario, which auto-escalates as
// "unclassified_problem" — so every Bluebeam problem was escalated unread. Worse,
// "Bluebeam is slow" matched the generic `slow` keyword and was misclassified as
// a Windows storage problem, sending the employee down an unrelated tree.
//
// This module derives ScenarioDefs from the existing ten families rather than
// duplicating them, so the skill pack stays the single source of truth. It adds
// no new families and no parallel workflow: the existing engine still owns
// authorization, approval, audit, durable resume, verification and handoff.
//
// Pure module. No network, no device, no execution.
// ============================================================
import {
  BLUEBEAM_FAMILIES, BLUEBEAM_FAMILY_KEYS, bluebeamFamily,
  type BluebeamFamilyKey, type BluebeamFamily
} from '../skills/bluebeam/families';
import { classifyBluebeam, isBluebeamIntent } from '../skills/bluebeam/intents';
import { mayWatsonAttemptRepair, type CauseClass } from '../support/causes';
import type { ScenarioDef } from './scenarios';
import type { Confidence } from './cases';

// Scenario keys mirror family keys 1:1. These are registry entries, not new
// families — `familyKeyForScenario` is total and reversible.
export const BLUEBEAM_SCENARIO_PREFIX = 'bluebeam_';

export type BluebeamScenarioKey = `bluebeam_${BluebeamFamilyKey}`;

export const BLUEBEAM_SCENARIO_KEYS: BluebeamScenarioKey[] =
  BLUEBEAM_FAMILY_KEYS.map((k) => `${BLUEBEAM_SCENARIO_PREFIX}${k}` as BluebeamScenarioKey);

export function scenarioKeyForFamily(f: BluebeamFamilyKey): BluebeamScenarioKey {
  return `${BLUEBEAM_SCENARIO_PREFIX}${f}` as BluebeamScenarioKey;
}

export function isBluebeamScenarioKey(k: string): k is BluebeamScenarioKey {
  return typeof k === 'string' && k.startsWith(BLUEBEAM_SCENARIO_PREFIX) &&
    (BLUEBEAM_FAMILY_KEYS as string[]).includes(k.slice(BLUEBEAM_SCENARIO_PREFIX.length));
}

export function familyKeyForScenario(k: string): BluebeamFamilyKey | null {
  return isBluebeamScenarioKey(k) ? (k.slice(BLUEBEAM_SCENARIO_PREFIX.length) as BluebeamFamilyKey) : null;
}

// ------------------------------------------------------------
// Repair mapping.
//
// Only two families map to an existing simulated action. Every other family
// deliberately has NO repair: the safe response is guidance, verification, or a
// technician. An absent repair key is a design decision, not an omission — see
// the per-family prohibited actions.
// ------------------------------------------------------------
const REPAIR_ACTION_BY_FAMILY: Partial<Record<BluebeamFamilyKey, string>> = {
  launch_stability: 'restart_app',
  file_sync_locking: 'refresh_onedrive'
};

// ------------------------------------------------------------
// ScenarioDef derivation — the families ARE the definition.
// ------------------------------------------------------------
function toScenarioDef(f: BluebeamFamily): ScenarioDef {
  return {
    key: scenarioKeyForFamily(f.key) as unknown as ScenarioDef['key'],
    label: f.label,
    platforms: 'any',
    routingCategory: `bluebeam_${f.key}`,
    // Employee-safe checks only; every one is non-destructive by construction.
    plan: [...f.employeeSafeActions],
    // No automated connector checks: Bluebeam state comes from the employee in
    // this pilot, because no endpoint agent exists.
    checks: [],
    primaryHypothesis: { key: f.key, label: f.label },
    competingHypotheses: f.candidateCauses
      .filter((c) => c !== 'unknown_cause')
      .map((c) => ({ key: c, label: c })),
    repairActionKey: REPAIR_ACTION_BY_FAMILY[f.key],
    employeeExplanation: f.label,
    followupNeeds: f.branches.map((b) => b.evidenceKey)
  };
}

export const BLUEBEAM_SCENARIO_DEFS: Record<string, ScenarioDef> =
  Object.fromEntries(BLUEBEAM_FAMILY_KEYS.map((k) => [scenarioKeyForFamily(k), toScenarioDef(BLUEBEAM_FAMILIES[k])]));

// ------------------------------------------------------------
// Classification
// ------------------------------------------------------------

// Statements that mention Bluebeam but are really about another system. These
// must NOT be captured by the Bluebeam pack — routing an Outlook sign-in loop
// into the Bluebeam licensing tree wastes the employee's time.
const NOT_BLUEBEAM = [
  /\boutlook\b/i,
  /\bteams\b/i,
  /\bsharepoint\b/i,
  /\bonedrive\b/i,
  /\bwindows (is |feels )?slow\b/i,
  /\bmy (pc|computer|laptop) is slow\b/i,
  /\badobe\b/i,
  /\bacrobat\b/i
];

// Returns a Bluebeam scenario key, or null when this is not a Bluebeam problem.
// Conservative on purpose: when in doubt it declines rather than capturing the
// case, because a wrong family is worse than no family.
export function classifyBluebeamScenarioKey(text: string): BluebeamScenarioKey | null {
  const t = String(text ?? '');
  if (!isBluebeamIntent(t)) return null;

  // A competing product/system named alongside Bluebeam means we should not
  // assume the Bluebeam pack — unless Bluebeam is the clear subject.
  const mentionsOther = NOT_BLUEBEAM.some((r) => r.test(t));
  const explicitlyBluebeam = /\b(bluebeam|revu)\b/i.test(t);
  if (mentionsOther && !explicitlyBluebeam) return null;

  const c = classifyBluebeam(t);
  if (!c.family) return null;
  return scenarioKeyForFamily(c.family);
}

// True when the statement matched several families and we should ask one narrow
// question rather than guess.
export function bluebeamIsAmbiguous(text: string): boolean {
  if (!isBluebeamIntent(String(text ?? ''))) return false;
  return classifyBluebeam(String(text ?? '')).alternatives.length > 0;
}

// ------------------------------------------------------------
// One-question-at-a-time evidence
// ------------------------------------------------------------
export interface BluebeamQuestion {
  question: string;
  evidenceKey: string;
  remaining: number;
}

export function nextBluebeamQuestion(
  familyKey: BluebeamFamilyKey,
  known: Record<string, unknown>
): BluebeamQuestion | null {
  const f = bluebeamFamily(familyKey);
  const unanswered = f.branches.filter((b) => !(b.evidenceKey in (known ?? {})));
  if (unanswered.length === 0) return null;
  return { question: unanswered[0].question, evidenceKey: unanswered[0].evidenceKey, remaining: unanswered.length };
}

const YES = /\b(yes|yeah|yep|it does|correct|true|works|fine|ok|okay)\b/i;
const NO = /\b(no|nope|it does not|doesn.t|does not|never|fails|failed|broken|cannot|can.t)\b/i;

// Interpret a free-text employee answer into one of the branch's declared
// `whenAnswer` values. Unrecognised answers return null so the engine re-asks
// rather than recording a guess as evidence.
export function interpretBluebeamAnswer(
  familyKey: BluebeamFamilyKey,
  evidenceKey: string,
  text: string
): string | null {
  const t = String(text ?? '').toLowerCase();
  const branch = bluebeamFamily(familyKey).branches.find((b) => b.evidenceKey === evidenceKey);
  if (!branch) return null;
  const allowed = branch.outcomes.map((o) => o.whenAnswer);

  // Exact/keyword matches against the declared outcomes first.
  for (const a of allowed) {
    const words = a.split('_').filter((w) => w.length > 3);
    if (words.length > 0 && words.every((w) => t.includes(w))) return a;
  }

  // Targeted natural-language mappings for the high-traffic branches.
  const map: Record<string, Array<[RegExp, string]>> = {
    'bluebeam.launch.stage': [
      [/never|not at all|nothing happens|will not open|won.t open|wont open/i, 'never_opens'],
      [/freez|hang|then crash|after.*open|opens.*then/i, 'opens_then_freezes'],
      [/slow|sluggish|laggy/i, 'slow_throughout']
    ],
    'bluebeam.signin.provider': [
      [/microsoft|office|365|work account/i, 'microsoft'],
      [/bluebeam|revu/i, 'bluebeam']
    ],
    'bluebeam.studio.kind': [
      [/session/i, 'session'],
      [/project/i, 'project']
    ],
    'bluebeam.studio.othersAffected': [
      [/others.*(too|also)|everyone|team.*(too|also)|yes/i, 'yes_others_too'],
      [/only me|just me|no.*others|others.*fine|no\b/i, 'no_others_fine']
    ],
    'bluebeam.reproducesOnOtherDevice': [
      [/works there|fine there|opens there|yes/i, 'yes_works_there'],
      [/fails there|same there|also fails|no\b/i, 'no_fails_there_too']
    ],
    'bluebeam.pdf.origin': [
      [/scan/i, 'scanned'],
      [/cad|autocad|revit|export/i, 'cad_export']
    ],
    'bluebeam.print.symptom': [
      [/wrong size|clip|cut off|too small|too big|scale/i, 'wrong_size_or_clipped'],
      [/nothing|no output|does not print|doesn.t print/i, 'nothing_prints']
    ],
    'bluebeam.file.location': [
      [/sharepoint|onedrive|teams|synced|cloud/i, 'sharepoint_or_onedrive'],
      [/local|my computer|desktop|c drive|c:/i, 'local']
    ],
    'bluebeam.ocr.textSelectable': [
      [/picture|image|cannot select|can.t select|no text/i, 'behaves_like_picture'],
      [/can select|selectable|yes/i, 'text_selectable']
    ],
    'bluebeam.settings.lostWhat': [
      [/tool ?chest|tool ?set|tools/i, 'toolchest'],
      [/everything|whole|all of it|profile/i, 'whole_profile']
    ],
    'bluebeam.profile.loaded': [
      [/yes|still there|correct/i, 'yes'],
      [/no|different|missing|gone/i, 'no']
    ]
  };
  for (const [re, value] of map[evidenceKey] ?? []) {
    if (re.test(t)) return value;
  }

  // Generic yes/no when the branch declares those outcomes.
  if (allowed.includes('yes') && YES.test(t) && !NO.test(t)) return 'yes';
  if (allowed.includes('no') && NO.test(t)) return 'no';
  return null;
}

// ------------------------------------------------------------
// Diagnosis: apply the family's confidence deltas to the recorded answers.
// ------------------------------------------------------------
export interface BluebeamAssessment {
  cause: CauseClass;
  confidence: Confidence;
  score: number;
  rationale: string[];
  sufficient: boolean;
  repairable: boolean;
}

export function assessBluebeam(familyKey: BluebeamFamilyKey, known: Record<string, unknown>): BluebeamAssessment {
  const f = bluebeamFamily(familyKey);
  const byCause = new Map<CauseClass, number>();
  const rationale: string[] = [];
  let answered = 0;

  for (const b of f.branches) {
    const answer = known?.[b.evidenceKey];
    if (typeof answer !== 'string') continue;
    answered++;
    const outcome = b.outcomes.find((o) => o.whenAnswer === answer);
    if (!outcome) continue;
    byCause.set(outcome.cause, (byCause.get(outcome.cause) ?? 0) + outcome.confidenceDelta);
    rationale.push(outcome.note);
  }

  const complete = answered === f.branches.length;
  if (byCause.size === 0) {
    return { cause: 'unknown_cause', confidence: 'low', score: 0, rationale, sufficient: false, repairable: false };
  }

  const ranked = [...byCause.entries()].sort((a, b) => b[1] - a[1]);
  const [cause, score] = ranked[0];

  // A negative or zero score means the evidence actively argues against acting —
  // for example unsynced work present, or no reference dimension to calibrate
  // against. That must never become a confident diagnosis.
  if (score <= 0) {
    return { cause: 'unknown_cause', confidence: 'low', score, rationale, sufficient: false, repairable: false };
  }

  const confidence: Confidence = !complete ? 'low' : score >= 40 ? 'high' : score >= 20 ? 'moderate' : 'low';
  const sufficient = complete && confidence !== 'low';
  return {
    cause,
    confidence,
    score,
    rationale,
    sufficient,
    // Repair requires BOTH a repairable cause class AND sufficient evidence.
    repairable: sufficient && mayWatsonAttemptRepair(cause)
  };
}

// The simulated action key for a family, but only when the assessment justifies
// acting at all. Returns undefined for every other case, which the engine treats
// as "no safe repair — escalate or park".
export function bluebeamRepairActionKey(
  familyKey: BluebeamFamilyKey,
  a: BluebeamAssessment
): string | undefined {
  if (!a.repairable) return undefined;
  return REPAIR_ACTION_BY_FAMILY[familyKey];
}

// ------------------------------------------------------------
// Business impact (Phase 3). Measurement and file-lock families escalate
// priority because both can silently corrupt work that later gets priced.
// ------------------------------------------------------------
export type ImpactSignal =
  | 'unable_to_work' | 'work_degraded' | 'one_project' | 'multiple_projects'
  | 'pricing_takeoff_risk' | 'possible_data_loss';

export function detectImpactSignals(text: string, familyKey: BluebeamFamilyKey | null): ImpactSignal[] {
  const t = String(text ?? '').toLowerCase();
  const out = new Set<ImpactSignal>();
  if (/cannot work|can.t work|completely stuck|blocked|dead in the water/.test(t)) out.add('unable_to_work');
  if (/slow|workaround|painful|takes ages/.test(t)) out.add('work_degraded');
  if (/all (my )?projects|several projects|multiple projects|every job/.test(t)) out.add('multiple_projects');
  else if (/project|job|bid|tender/.test(t)) out.add('one_project');
  if (/takeoff|take.?off|estimate|pricing|quantit|bid/.test(t)) out.add('pricing_takeoff_risk');
  if (/lost|losing|gone|deleted|missing markups|unsaved/.test(t)) out.add('possible_data_loss');

  // Family-driven signals: these two families carry the risk regardless of
  // wording, because the employee often does not realise work is at stake.
  if (familyKey === 'measurement_scale') out.add('pricing_takeoff_risk');
  if (familyKey === 'file_sync_locking') out.add('possible_data_loss');
  return [...out];
}

export function priorityFromImpact(signals: readonly ImpactSignal[]): 'low' | 'normal' | 'high' | 'urgent' {
  if (signals.includes('pricing_takeoff_risk') || signals.includes('possible_data_loss')) return 'urgent';
  if (signals.includes('unable_to_work') || signals.includes('multiple_projects')) return 'high';
  if (signals.includes('one_project') || signals.includes('work_degraded')) return 'normal';
  return 'normal';
}

// Employee-facing confidence wording. Never exposes scores or family keys.
export function confidenceWording(a: BluebeamAssessment): string {
  if (a.cause === 'unknown_cause') return 'I do not have enough evidence yet to say what is causing this.';
  if (a.confidence === 'high') return 'I am confident about the cause.';
  if (a.confidence === 'moderate') return 'This is the likely cause, based on what you have told me.';
  return 'I have a possible cause, but not enough evidence to act on it.';
}
