// ============================================================
// Watson — H&R AI IT Agent : Employee case ENGINE (orchestrator)
// ------------------------------------------------------------
// Ties the deterministic pieces together: conversation intake, automatic
// diagnostic planning + orchestration (reusing the existing M365 read-only
// diagnostic system), the triple-check engine, rule-based estimation, employee
// approval, safe simulated repair, verification, escalation, and reporting.
//
// Everything is mock/read-only and deterministic. Watson investigates as an
// internal SYSTEM service actor (authorized to read the EMPLOYEE'S OWN account
// via the existing policy); the employee never invokes admin diagnostics and
// never sees tool/action names or raw payloads.
// ============================================================
import type { Actor } from '../types';
import { runM365Diagnostic } from '../graph/graph-diagnostics';
import { isGraphLiveReadOnlyEnabled } from '../graph/graph-config';
import { ensureMockIdentity } from '../seed-knowledge';
import {
  isBluebeamScenarioKey, familyKeyForScenario, nextBluebeamQuestion,
  interpretBluebeamAnswer, assessBluebeam, bluebeamRepairActionKey,
  detectImpactSignals, priorityFromImpact, confidenceWording
} from './bluebeam-bridge';
import { bluebeamFamily } from '../skills/bluebeam/families';
import { causeProfile } from '../support/causes';
import { mockDevice } from '../mock-device-management';
import {
  SCENARIOS, SIMULATED_ACTIONS, classifyScenario, detectPlatform, estimateFor, UNKNOWN_ESTIMATE,
  type ScenarioDef, type SimulatedActionDef
} from './scenarios';
import {
  createCase, getCaseForActor, touch, auditCase,
  type WatsonCase, type Platform, type EvidenceItem, type EvidenceStrength,
  type Hypothesis, type Confidence, type TripleCheckResult, type ProposedSolution, type AttachmentMeta,
  type SimulatedRun
} from './cases';

// Internal service identity — authorized to read employee M365 data for
// diagnostics. NEVER exposed to the employee and never used for writes.
const WATSON_SERVICE: Actor = { id: 'watson-service', type: 'system', role: 'system', email: 'watson@hrelectriccompany.com', displayName: 'Watson (service)' };

export interface WatsonTurn {
  case: WatsonCase;
  reply: string;          // plain-language Watson message (also spoken via seam)
  followupQuestion?: string;
  needsApproval?: boolean;
  // Set when the employee typed into a case that is already finished. The
  // caller must open a NEW case rather than appending, which is what previously
  // caused "Thank you — noted." to land on a resolved transcript.
  requiresNewCase?: boolean;
}

function watsonSay(c: WatsonCase, text: string): void {
  c.messages.push({ id: 'm' + c.messages.length, role: 'watson', text, at: c.updatedAt });
}
function employeeSay(c: WatsonCase, text: string): void {
  c.messages.push({ id: 'm' + c.messages.length, role: 'employee', text, at: c.updatedAt });
}

// ------------------------------------------------------------
// Diagnostic orchestration — runs the scenario's checks and normalizes evidence.
// Raw payloads never leave here; only employee-safe summaries + strengths.
// ------------------------------------------------------------
async function runChecks(c: WatsonCase, def: ScenarioDef): Promise<EvidenceItem[]> {
  const email = c.employeeEmail ?? '';
  const evidence: EvidenceItem[] = [];
  for (const check of def.checks) {
    if (check.read) {
      const outcome = await runM365Diagnostic(WATSON_SERVICE, check.read, email);
      let strength: EvidenceStrength = 'unavailable';
      let summary = 'This information was not available.';
      if (outcome.outcome === 'evidence') {
        const st = outcome.result.state;
        if (st === 'ok') { strength = 'confirmed'; summary = 'Looks healthy.'; }
        else if (st === 'not_found') { strength = 'contradictory'; summary = 'No matching record was found.'; }
        else { strength = 'unavailable'; summary = 'This information was not available.'; }
      } else {
        strength = 'unavailable';
      }
      evidence.push({ check: check.label, strength, summary });
    } else if (check.kind === 'this_device') {
      const device = mockDevice.lookupDeviceByEmail(email, WATSON_SERVICE);
      if (device) evidence.push({ check: check.label, strength: 'confirmed', summary: 'This device is reachable and managed.' });
      else evidence.push({ check: check.label, strength: 'unavailable', summary: 'No managed device is registered for you.' });
    } else if (check.kind === 'signin') {
      // Deterministic mock: recent sign-in activity indicates a local session issue
      // rather than an account block (used to support the expired-session cause).
      evidence.push({ check: check.label, strength: 'strongly_indicated', summary: 'Recent sign-ins succeeded; the local session looks expired.' });
    } else if (check.kind === 'service_health') {
      evidence.push({ check: check.label, strength: 'not_applicable', summary: 'No Microsoft 365 service problems are reported.' });
    }
    auditCase(WATSON_SERVICE, 'diagnostic_read_performed', c, { check: check.label });
  }
  return evidence;
}

function accountHealthy(evidence: EvidenceItem[]): boolean {
  const account = evidence.find((e) => /account/i.test(e.check));
  return !account || account.strength === 'confirmed';
}
function anyUnavailable(evidence: EvidenceItem[]): boolean {
  return evidence.some((e) => e.strength === 'unavailable');
}
function anyContradictory(evidence: EvidenceItem[]): boolean {
  return evidence.some((e) => e.strength === 'contradictory');
}

function buildHypotheses(def: ScenarioDef, evidence: EvidenceItem[]): Hypothesis[] {
  const healthy = accountHealthy(evidence);
  const primaryStrength: EvidenceStrength =
    anyContradictory(evidence) ? 'contradictory'
    : !healthy ? 'possible'
    : anyUnavailable(evidence) ? 'possible'
    : 'strongly_indicated';
  const hs: Hypothesis[] = [{ key: def.primaryHypothesis.key, label: def.primaryHypothesis.label, strength: primaryStrength, primary: true }];
  for (const comp of def.competingHypotheses) {
    // If the account is unhealthy, the account-related competing cause rises.
    const isAccount = /account|disabled/i.test(comp.label);
    hs.push({ key: comp.key, label: comp.label, strength: !healthy && isAccount ? 'strongly_indicated' : 'possible', primary: false });
  }
  return hs;
}

function confidenceFrom(evidence: EvidenceItem[], hypotheses: Hypothesis[]): Confidence {
  const primary = hypotheses.find((h) => h.primary);
  if (!primary || primary.strength === 'contradictory' || primary.strength === 'possible') return 'low';
  if (anyUnavailable(evidence)) return 'moderate';
  return primary.strength === 'strongly_indicated' || primary.strength === 'confirmed' ? 'high' : 'moderate';
}

// ------------------------------------------------------------
// Triple-check engine (Part G).
// ------------------------------------------------------------
function tripleCheck(def: ScenarioDef, c: WatsonCase, evidence: EvidenceItem[], hypotheses: Hypothesis[]): TripleCheckResult {
  const confidence = confidenceFrom(evidence, hypotheses);
  const primary = hypotheses.find((h) => h.primary)!;
  const action = def.repairActionKey ? SIMULATED_ACTIONS[def.repairActionKey] : undefined;

  // Gate 1 — diagnosis
  const g1: string[] = [];
  if (!(primary.strength === 'strongly_indicated' || primary.strength === 'confirmed')) g1.push('cause_not_specific_enough');
  if (anyContradictory(evidence)) g1.push('contradictory_evidence');
  if (confidence === 'low') g1.push('confidence_too_low');
  const diagnosisGate = { passed: g1.length === 0, reasons: g1 };

  // Gate 2 — repair suitability
  const g2: string[] = [];
  if (!action) g2.push('no_safe_repair_for_scenario');
  else {
    const platformOk = action.platforms.includes(c.platform) || c.platform === 'unknown';
    if (!platformOk) g2.push('repair_platform_mismatch');
    if (c.runs.some((r) => r.actionKey === action.key && r.status === 'unexpected_state')) g2.push('repair_already_failed');
    if (action.verificationSteps.length === 0) g2.push('cannot_verify');
    if (action.preconditions.includes('device_managed') && !(c.deviceContext?.managed ?? mockDevice.lookupDeviceByEmail(c.employeeEmail ?? '', WATSON_SERVICE) !== null)) g2.push('device_not_managed');
  }
  const suitabilityGate = { passed: g2.length === 0, reasons: g2 };

  // Gate 3 — safety & authority
  const g3: string[] = [];
  if (action) {
    if (!action.expectedInterruption) g3.push('interruption_unknown');
    if (action.reversibility === 'unknown' || action.reversibility === 'irreversible') g3.push('reversibility_insufficient');
    if (action.approvalLevel !== 'employee') g3.push('requires_higher_approval');
  } else {
    g3.push('no_action');
  }
  const safetyGate = { passed: g3.length === 0, reasons: g3 };

  const passed = diagnosisGate.passed && suitabilityGate.passed && safetyGate.passed;
  let escalationReason: string | undefined;
  if (!passed) {
    escalationReason = !diagnosisGate.passed ? 'diagnosis_uncertain'
      : !suitabilityGate.passed ? 'no_suitable_safe_repair'
      : 'requires_admin_authority';
  }
  return { diagnosisGate, suitabilityGate, safetyGate, passed, confidence, escalationReason };
}

function proposeSolution(def: ScenarioDef, action: SimulatedActionDef): ProposedSolution {
  return {
    actionKey: action.key,
    title: action.title,
    explanation: (def.employeeExplanation ? def.employeeExplanation + ' ' : '') + action.explanation,
    expectedInterruption: action.expectedInterruption,
    reversibility: action.reversibility,
    approvalLevel: action.approvalLevel,
    verificationPlan: action.verificationSteps
  };
}

// ------------------------------------------------------------
// Escalation (Part L) — builds employee summary + technician brief.
// ------------------------------------------------------------
function escalate(actor: Actor, c: WatsonCase, reason: string, def: ScenarioDef, security = false): void {
  c.state = 'escalated';
  c.escalation = { escalated: true, reason, routingCategory: def.routingCategory, queue: 'watson-support', securityFlag: security };
  c.assigned = { queue: 'watson-support', owner: null };
  // Priority follows business impact + security.
  c.priority = security ? 'urgent' : c.businessImpact === 'company' || c.businessImpact === 'team' ? 'high' : c.urgency;
  const responseLabel = security ? 'within 30 minutes' : c.priority === 'high' ? 'within 2 hours' : 'within 1 business day';
  c.estimate = { known: false, label: 'A technician will review this', responseLabel, repairAfterReviewLabel: 'estimated after review' };
  c.employeeReport = buildEmployeeReport(c, def, { escalated: true, responseLabel });
  c.adminReport = buildAdminReport(c, def);
  auditCase(actor, 'case_escalated', c, { reason, routingCategory: def.routingCategory, security });
  auditCase(actor, 'report_generated', c, { kind: 'escalation' });
  watsonSay(c, security
    ? 'I have flagged this to the security team as a priority. They will contact you shortly.'
    : 'I could not resolve this safely on my own, so I have created a support issue and a technician will take it from here.');
  touch(c);
}

// ------------------------------------------------------------
// Reports (Part M).
// ------------------------------------------------------------
function buildEmployeeReport(c: WatsonCase, def: ScenarioDef, opts: { escalated?: boolean; responseLabel?: string } = {}) {
  return {
    problem: c.problemSummary || def.label,
    cause: c.hypotheses.find((h) => h.primary)?.label ?? 'Under review',
    checksPerformed: c.evidence.map((e) => e.check),
    solutionOrEscalation: opts.escalated ? 'Passed to a technician' : c.proposedSolution?.title ?? 'In progress',
    currentStatus: c.state,
    expectedResponse: opts.responseLabel,
    followUp: opts.escalated ? 'A technician will follow up with you.' : 'Let me know if the problem returns.'
  };
}
function buildAdminReport(c: WatsonCase, def: ScenarioDef) {
  return {
    problem: c.problemSummary || def.label,
    originalStatement: c.originalStatement,
    device: c.deviceContext?.label ?? 'unknown',
    platform: c.platform,
    diagnosticPlan: c.diagnosticPlan,
    evidence: c.evidence,
    hypotheses: c.hypotheses,
    tripleCheck: c.tripleCheck,
    confidence: c.confidence,
    estimate: c.estimate,
    approvals: c.approval,
    actions: c.runs.map((r) => ({ actionKey: r.actionKey, status: r.status, beforeState: r.beforeState, afterState: r.afterState })),
    verification: c.verification,
    escalation: c.escalation,
    routingCategory: def.routingCategory,
    auditRefs: c.auditRefs,
    prevention: 'Consider proactive session-refresh reminders for recurring Outlook sign-in prompts.'
  };
}

// ------------------------------------------------------------
// Public engine operations.
// ------------------------------------------------------------
export async function startCase(actor: Actor, statement: string, opts: { platform?: Platform; deviceLabel?: string } = {}): Promise<WatsonTurn> {
  // In MOCK mode, ensure the authenticated employee has a deterministic healthy
  // mock M365 profile + device so the mock experience demonstrates the full flow
  // (real pilot users are not in the fixed seed set). Inert in live mode.
  if (!isGraphLiveReadOnlyEnabled(process.env)) ensureMockIdentity(actor.email, actor.displayName);
  const platform = opts.platform && opts.platform !== 'unknown' ? opts.platform : detectPlatform(statement);
  const managedDevice = mockDevice.lookupDeviceByEmail(actor.email ?? '', WATSON_SERVICE);
  const c = createCase({
    actor, platform,
    deviceContext: managedDevice ? { label: managedDevice.deviceName, managed: true } : (opts.deviceLabel ? { label: opts.deviceLabel, managed: false } : null),
    originalStatement: statement
  });
  employeeSay(c, statement);
  auditCase(actor, 'case_created', c);
  auditCase(actor, 'employee_message_recorded', c, { role: 'employee' });
  return investigate(actor, c);
}

async function investigate(actor: Actor, c: WatsonCase): Promise<WatsonTurn> {
  const scenario = classifyScenario([c.originalStatement, ...c.messages.filter((m) => m.role === 'employee').map((m) => m.text)].join(' '));
  const def = SCENARIOS[scenario];
  c.scenario = scenario;
  c.problemSummary = def.label;
  c.diagnosticPlan = def.plan;
  c.state = 'investigating';
  c.needs = []; // recomputed below; cleared so a resolved follow-up is not re-asked

  // Bluebeam families run the skill pack's own evidence tree. They reuse this
  // engine's authorization, approval, audit, resume, verification and handoff —
  // only the diagnostic content differs.
  if (isBluebeamScenarioKey(scenario)) return investigateBluebeam(actor, c, def);

  // Auto-escalation scenarios (lost device -> security; unknown -> general).
  if (def.autoEscalate) {
    c.businessImpact = def.autoEscalate === 'security' ? 'individual' : c.businessImpact;
    // Record the primary hypothesis so the reports read meaningfully.
    c.hypotheses = [{ key: def.primaryHypothesis.key, label: def.primaryHypothesis.label, strength: 'strongly_indicated', primary: true }];
    escalate(actor, c, def.autoEscalate === 'security' ? 'lost_or_stolen_device' : 'unclassified_problem', def, def.autoEscalate === 'security');
    return { case: c, reply: c.messages[c.messages.length - 1].text };
  }

  // One focused follow-up if platform is required but unknown.
  if (def.platforms !== 'any' && c.platform === 'unknown' && def.followupNeeds.includes('platform')) {
    c.state = 'waiting_for_employee';
    c.needs = ['platform'];
    auditCase(actor, 'diagnostic_plan_created', c, { needs: 'platform' });
    touch(c);
    const q = 'Which device is this happening on — your Windows PC or your Mac?';
    watsonSay(c, q);
    return { case: c, reply: q, followupQuestion: q };
  }

  auditCase(actor, 'diagnostic_plan_created', c, { checks: def.checks.length });
  const evidence = await runChecks(c, def);
  c.evidence = evidence;
  c.hypotheses = buildHypotheses(def, evidence);
  const tc = tripleCheck(def, c, evidence, c.hypotheses);
  c.tripleCheck = tc;
  c.confidence = tc.confidence;

  if (!tc.passed) {
    auditCase(actor, 'diagnosis_blocked', c, { reason: tc.escalationReason, gates: { d: tc.diagnosisGate.passed, s: tc.suitabilityGate.passed, safe: tc.safetyGate.passed } });
    escalate(actor, c, tc.escalationReason ?? 'blocked', def);
    return { case: c, reply: c.messages[c.messages.length - 1].text };
  }

  const action = SIMULATED_ACTIONS[def.repairActionKey!];
  const solution = proposeSolution(def, action);
  c.proposedSolution = solution;
  c.estimate = estimateFor(action);
  c.approval = { required: true, level: action.approvalLevel, state: 'requested' };
  c.state = 'waiting_for_approval';
  auditCase(actor, 'diagnosis_proposed', c, { confidence: tc.confidence, action: action.key });
  auditCase(actor, 'repair_estimated', c, { estimate: c.estimate.label });
  auditCase(actor, 'employee_approval_requested', c, { level: action.approvalLevel });
  const msg = `${solution.explanation} The repair should take ${c.estimate.label.toLowerCase()} and ${solution.expectedInterruption.toLowerCase()} Would you like me to go ahead?`;
  watsonSay(c, msg);
  touch(c);
  return { case: c, reply: msg, needsApproval: true };
}


// Bluebeam diagnosis: one evidence question per turn, then an evidence-backed
// cause. A repair is proposed ONLY when the cause is repairable AND the evidence
// is sufficient; every other outcome escalates rather than guessing.
async function investigateBluebeam(actor: Actor, c: WatsonCase, def: ScenarioDef): Promise<WatsonTurn> {
  const familyKey = familyKeyForScenario(c.scenario);
  if (!familyKey) { escalate(actor, c, 'unclassified_problem', def); return { case: c, reply: c.messages[c.messages.length - 1].text }; }
  const family = bluebeamFamily(familyKey);

  // Business impact drives priority. Measurement and file-lock families carry
  // takeoff/data-loss risk regardless of wording, so priority rises even when
  // the employee describes the problem calmly.
  const allText = [c.originalStatement, ...c.messages.filter((m) => m.role === 'employee').map((m) => m.text)].join(' ');
  const signals = detectImpactSignals(allText, familyKey);
  c.known.impactSignals = signals;
  c.priority = priorityFromImpact(signals);
  c.urgency = c.priority;

  // One question at a time; never re-ask something already recorded.
  const q = nextBluebeamQuestion(familyKey, c.known);
  if (q) {
    c.state = 'waiting_for_employee';
    c.needs = [q.evidenceKey];
    auditCase(actor, 'diagnostic_plan_created', c, { needs: q.evidenceKey, remaining: q.remaining });
    watsonSay(c, q.question);
    touch(c);
    return { case: c, reply: q.question, followupQuestion: q.question };
  }

  const a = assessBluebeam(familyKey, c.known);
  c.confidence = a.confidence;
  c.hypotheses = [{
    key: a.cause,
    label: causeProfile(a.cause).label,
    strength: a.sufficient ? 'strongly_indicated' : 'possible',
    primary: true
  }];
  c.evidence = family.branches
    .filter((b) => typeof c.known[b.evidenceKey] === 'string')
    .map((b) => ({
      check: b.question,
      strength: (a.sufficient ? 'strongly_indicated' : 'possible') as EvidenceItem['strength'],
      // Employee-safe: the recorded answer only, never a raw payload or path.
      summary: `You told me: ${String(c.known[b.evidenceKey]).replace(/_/g, ' ')}`
    }));

  const repairKey = bluebeamRepairActionKey(familyKey, a);
  if (!repairKey) {
    // No safe repair. This is a deliberate outcome for most families: the safe
    // response is a technician with a full record, not a guessed change.
    auditCase(actor, 'diagnosis_blocked', c, { cause: a.cause, confidence: a.confidence, sufficient: a.sufficient });
    escalate(actor, c, a.sufficient ? `no_safe_repair_${a.cause}` : 'insufficient_evidence', def);
    return { case: c, reply: c.messages[c.messages.length - 1].text };
  }

  const action = SIMULATED_ACTIONS[repairKey];
  const solution = proposeSolution(def, action);
  c.proposedSolution = solution;
  c.estimate = estimateFor(action);
  c.approval = { required: true, level: action.approvalLevel, state: 'requested' };
  c.state = 'waiting_for_approval';
  auditCase(actor, 'diagnosis_proposed', c, { confidence: a.confidence, action: action.key, cause: a.cause });
  auditCase(actor, 'employee_approval_requested', c, { level: action.approvalLevel });
  const msg = `${confidenceWording(a)} ${solution.explanation} This is simulated in the current pilot — nothing on your computer is changed. It should take ${c.estimate.label.toLowerCase()} and ${solution.expectedInterruption.toLowerCase()} Would you like me to go ahead?`;
  watsonSay(c, msg);
  touch(c);
  return { case: c, reply: msg, needsApproval: true };
}

// Employee sends a message (answer to a follow-up, a correction, or a new detail).
export async function addEmployeeMessage(actor: Actor, caseId: string, text: string): Promise<WatsonTurn | null> {
  const c = getCaseForActor(caseId, actor);
  if (!c) return null;

  // A finished case is IMMUTABLE. Previously any further message appended
  // "Thank you — noted." to a resolved transcript until reload; a new problem
  // must open a new case instead.
  if (c.state === 'resolved' || c.state === 'closed' || c.state === 'escalated') {
    return {
      case: c,
      reply: 'That issue is already finished, so I have started a new one for you.',
      requiresNewCase: true
    };
  }

  employeeSay(c, text);
  auditCase(actor, 'employee_message_recorded', c, { role: 'employee' });

  // Technician request at any time.
  if (/technician|human|person|someone|escalate/i.test(text)) {
    escalate(actor, c, 'employee_requested_technician', SCENARIOS[c.scenario]);
    return { case: c, reply: c.messages[c.messages.length - 1].text };
  }

  // Correction of the device assumption (invalidate prior platform).
  const corrected = detectPlatform(text);
  if (corrected !== 'unknown' && corrected !== c.platform) {
    c.platform = corrected;
    c.known.platform = corrected;
    // Re-investigate with the corrected assumption; clears stale evidence.
    c.evidence = []; c.hypotheses = []; c.tripleCheck = null; c.proposedSolution = null;
    return investigate(actor, c);
  }

  // If we were waiting for the platform, and they answered it.
  if (c.state === 'waiting_for_employee' && c.needs.includes('platform') && corrected !== 'unknown') {
    c.platform = corrected; c.needs = [];
    return investigate(actor, c);
  }

  // Bluebeam evidence answer for the exact question just asked.
  if (c.needs.length > 0 && isBluebeamScenarioKey(c.scenario)) {
    const familyKey = familyKeyForScenario(c.scenario);
    const evidenceKey = c.needs[0];
    if (familyKey) {
      const value = interpretBluebeamAnswer(familyKey, evidenceKey, text);
      if (value === null) {
        // Unrecognised answer: re-ask rather than record a guess as evidence.
        const again = nextBluebeamQuestion(familyKey, c.known);
        const q = again ? again.question : 'Could you tell me a little more about what you are seeing?';
        watsonSay(c, q);
        touch(c);
        return { case: c, reply: q, followupQuestion: q };
      }
      c.known[evidenceKey] = value;
      c.needs = [];
      auditCase(actor, 'employee_message_recorded', c, { evidence: evidenceKey });
      return investigate(actor, c);
    }
  }

  touch(c);
  const ack = 'Thank you — noted.';
  watsonSay(c, ack);
  return { case: c, reply: ack };
}

export function decideApproval(actor: Actor, caseId: string, decision: 'approve' | 'decline'): WatsonTurn | null {
  const c = getCaseForActor(caseId, actor);
  if (!c || c.state !== 'waiting_for_approval' || !c.proposedSolution) return null;
  // Employees can only approve employee-level actions.
  if (c.proposedSolution.approvalLevel !== 'employee') {
    escalate(actor, c, 'requires_admin_authority', SCENARIOS[c.scenario]);
    return { case: c, reply: c.messages[c.messages.length - 1].text };
  }
  if (decision === 'decline') {
    c.approval.state = 'declined';
    c.state = 'waiting_for_employee';
    auditCase(actor, 'employee_approval_declined', c);
    const msg = 'No problem — I will not make any changes. Tell me if you would like to try something else or speak to a technician.';
    watsonSay(c, msg);
    touch(c);
    return { case: c, reply: msg };
  }
  c.approval.state = 'granted';
  c.state = 'technician_working';
  auditCase(actor, 'employee_approval_granted', c);
  const msg = 'Thank you. I will make the change now.';
  watsonSay(c, msg);
  touch(c);
  return { case: c, reply: msg };
}

// Run the single approved simulated action (no real change).
export function runSimulatedRepair(actor: Actor, caseId: string): WatsonTurn | null {
  const c = getCaseForActor(caseId, actor);
  if (!c || !c.proposedSolution) return null;
  if (c.approval.state !== 'granted') return { case: c, reply: 'I need your approval before making any change.' };
  const action = SIMULATED_ACTIONS[c.proposedSolution.actionKey];
  const before = { scenario: c.scenario, healthySignals: c.evidence.map((e) => e.strength) };
  const run: SimulatedRun = { actionKey: action.key, startedAt: c.updatedAt, beforeState: before, status: 'started', progressNote: action.steps[0] };
  c.runs.push(run);
  auditCase(actor, 'simulated_action_started', c, { action: action.key });

  // Deterministic simulation: the action completes and the environment reaches
  // the expected state (a real integration is never called).
  run.status = 'completed';
  run.completedAt = c.updatedAt;
  run.afterState = { ...before, repaired: true };
  run.progressNote = 'Completed';
  c.estimate = estimateFor(action); // could shrink during real progress
  c.state = 'waiting_for_verification';
  c.verification.systemVerified = true;   // system-level check passes in the mock
  auditCase(actor, 'simulated_action_completed', c, { action: action.key });
  auditCase(actor, 'verification_requested', c);
  const msg = `That is done. ${action.verificationSteps[0]} — is it working now?`;
  watsonSay(c, msg);
  touch(c);
  return { case: c, reply: msg };
}

export function stopSimulatedRepair(actor: Actor, caseId: string): WatsonTurn | null {
  const c = getCaseForActor(caseId, actor);
  if (!c) return null;
  const run = c.runs[c.runs.length - 1];
  if (run && run.status === 'started') {
    run.status = 'stopped';
    run.stoppedAt = c.updatedAt;
    auditCase(actor, 'simulated_action_stopped', c, { action: run.actionKey });
  }
  c.state = 'waiting_for_employee';
  const msg = 'I have stopped safely. Nothing was changed.';
  watsonSay(c, msg);
  touch(c);
  return { case: c, reply: msg };
}

// Employee confirms whether it worked (Part K). Simulated completion alone does
// NOT resolve — employee confirmation is required.
export function submitVerification(actor: Actor, caseId: string, choice: 'works' | 'still_broken' | 'partial' | 'unsure'): WatsonTurn | null {
  const c = getCaseForActor(caseId, actor);
  if (!c) return null;
  c.verification.employeeChoice = choice;
  if (choice === 'works') {
    c.verification.functionalVerified = true;
    c.state = 'resolved';
    c.employeeReport = buildEmployeeReport(c, SCENARIOS[c.scenario], {});
    c.adminReport = buildAdminReport(c, SCENARIOS[c.scenario]);
    auditCase(actor, 'verification_passed', c);
    auditCase(actor, 'case_resolved', c);
    auditCase(actor, 'report_generated', c, { kind: 'resolution' });
    const msg = 'Excellent — glad that is sorted. I have written up a short summary for you. Take care.';
    watsonSay(c, msg);
    touch(c);
    return { case: c, reply: msg };
  }
  if (choice === 'still_broken') {
    // Return to investigation in the SAME case (do not resolve, do not new-case).
    // The first repair failed, so escalate rather than loop on the same fix.
    auditCase(actor, 'verification_failed', c);
    c.runs.forEach((r) => { if (r.status === 'completed') r.status = 'unexpected_state'; });
    c.state = 'investigating';
    return investigateSyncFallback(actor, c);
  }
  if (choice === 'partial') {
    c.state = 'waiting_for_employee';
    auditCase(actor, 'verification_failed', c, { partial: true });
    const msg = 'Understood — partly better. Tell me what is still not working and I will keep looking.';
    watsonSay(c, msg);
    touch(c);
    return { case: c, reply: msg };
  }
  c.state = 'waiting_for_verification';
  const msg = 'No problem. Try the task once more when you can, and tell me if it works.';
  watsonSay(c, msg);
  touch(c);
  return { case: c, reply: msg };
}

// still_broken re-investigation: since the first repair failed, escalate rather
// than loop on the same failed repair.
function investigateSyncFallback(actor: Actor, c: WatsonCase): WatsonTurn {
  const def = SCENARIOS[c.scenario];
  escalate(actor, c, 'repair_did_not_resolve', def);
  return { case: c, reply: c.messages[c.messages.length - 1].text };
}

export function attachScreenshot(actor: Actor, caseId: string, meta: Omit<AttachmentMeta, 'id' | 'at'>): WatsonCase | null {
  const c = getCaseForActor(caseId, actor);
  if (!c) return null;
  c.attachments.push({ ...meta, id: 'att' + c.attachments.length, at: c.updatedAt });
  touch(c);
  return c;
}
