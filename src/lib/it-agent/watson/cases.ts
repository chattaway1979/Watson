// ============================================================
// Watson — H&R AI IT Agent : Employee support CASE model + store
// ------------------------------------------------------------
// Structured case state that backs the employee experience. Persistence goes
// through the existing db() repository (in-memory + optional JSON file), so a
// real database can replace it later without touching domain logic. Cases
// survive navigation within a running process. Privacy: we store transcript
// text and attachment METADATA only — never audio, passwords, tokens, or raw
// Graph payloads.
// ============================================================
import { db, save, uuid, nowIso } from '../../store/db';
import { writeAudit } from '../audit';
import type { Actor, AuditEventType } from '../types';

export type CaseState =
  | 'investigating'
  | 'waiting_for_employee'
  | 'waiting_for_approval'
  | 'escalated'
  | 'assigned'
  | 'technician_working'
  | 'waiting_for_verification'
  | 'resolved'
  | 'closed'
  | 'reopened';

export type Platform = 'windows' | 'macos' | 'ios' | 'ipados' | 'unknown';
export type ScenarioKey =
  | 'outlook_repeated_signin'
  | 'sharepoint_access'
  | 'teams_ipad_av'
  | 'onedrive_sync'
  | 'device_slow_storage'
  | 'lost_device'
  // Bluebeam families (013). These mirror the ten skill-pack family keys 1:1 —
  // registry entries, not new families. Enumerated literally rather than
  // imported so cases.ts stays free of a cycle back to the bridge.
  | 'bluebeam_launch_stability'
  | 'bluebeam_signin_licensing'
  | 'bluebeam_studio'
  | 'bluebeam_pdf_rendering'
  | 'bluebeam_printing_plotting'
  | 'bluebeam_measurement_scale'
  | 'bluebeam_markups_toolchest'
  | 'bluebeam_ocr_search_overlay'
  | 'bluebeam_file_sync_locking'
  | 'bluebeam_profiles_settings'
  | 'unknown';

export type EvidenceStrength =
  | 'confirmed'
  | 'strongly_indicated'
  | 'possible'
  | 'unavailable'
  | 'contradictory'
  | 'stale'
  | 'not_applicable';

export type Confidence = 'high' | 'moderate' | 'low';
export type Reversibility = 'reversible' | 'reversible_with_caveats' | 'irreversible' | 'unknown';
export type ApprovalLevel = 'none' | 'employee' | 'admin' | 'owner';

export interface CaseMessage {
  id: string;
  role: 'employee' | 'watson';
  text: string;
  at: string;
}
export interface AttachmentMeta {
  id: string;
  kind: 'screenshot' | 'photo';
  name: string;
  contentType: string;
  sizeBytes: number;
  at: string;
  // A short, safe caption only. NEVER OCR/image content or external analysis.
  note?: string;
}
export interface Hypothesis {
  key: string;
  label: string;
  strength: EvidenceStrength;
  primary: boolean;
}
export interface EvidenceItem {
  check: string;          // employee-safe label, e.g. "Checking your account"
  strength: EvidenceStrength;
  summary: string;        // normalized, employee-safe — never raw payload
}
export interface TimeEstimate {
  known: boolean;
  label: string;                 // "About 3–5 minutes" | "Unable to estimate…"
  minMinutes?: number;
  maxMinutes?: number;
  responseLabel?: string;        // escalation: expected human response time
  repairAfterReviewLabel?: string;
}
export interface ProposedSolution {
  actionKey: string;             // simulated repair action key
  title: string;                 // employee-safe
  explanation: string;           // plain language
  expectedInterruption: string;
  reversibility: Reversibility;
  approvalLevel: ApprovalLevel;
  verificationPlan: string[];
}
export interface TripleCheckResult {
  diagnosisGate: { passed: boolean; reasons: string[] };
  suitabilityGate: { passed: boolean; reasons: string[] };
  safetyGate: { passed: boolean; reasons: string[] };
  passed: boolean;
  confidence: Confidence;
  escalationReason?: string;
}
export interface SimulatedRun {
  actionKey: string;
  startedAt: string;
  completedAt?: string;
  stoppedAt?: string;
  beforeState: Record<string, unknown>;
  afterState?: Record<string, unknown>;
  status: 'started' | 'completed' | 'stopped' | 'unexpected_state';
  progressNote?: string;
}
export type VerificationChoice = 'works' | 'still_broken' | 'partial' | 'unsure';
export interface VerificationState {
  systemVerified: boolean;
  functionalVerified: boolean;
  employeeChoice?: VerificationChoice;
}
export interface EscalationState {
  escalated: boolean;
  reason?: string;
  routingCategory?: string;
  queue?: string;
  securityFlag?: boolean;
}

export interface WatsonCase {
  caseId: string;
  shortId: string;
  employeeId: string;
  employeeEmail?: string;
  createdAt: string;
  updatedAt: string;

  platform: Platform;
  deviceContext: { label: string; managed: boolean } | null;

  scenario: ScenarioKey;
  problemSummary: string;
  originalStatement: string;
  messages: CaseMessage[];
  attachments: AttachmentMeta[];

  businessImpact: 'none' | 'individual' | 'team' | 'company';
  urgency: 'low' | 'normal' | 'high' | 'urgent';
  priority: 'low' | 'normal' | 'high' | 'urgent';

  state: CaseState;

  diagnosticPlan: string[];       // employee-safe plain-language steps
  hypotheses: Hypothesis[];
  evidence: EvidenceItem[];
  confidence: Confidence | null;

  proposedSolution: ProposedSolution | null;
  estimate: TimeEstimate | null;
  tripleCheck: TripleCheckResult | null;

  approval: { required: boolean; level: ApprovalLevel; state: 'none' | 'requested' | 'granted' | 'declined' };

  runs: SimulatedRun[];
  verification: VerificationState;
  escalation: EscalationState;

  assigned: { queue: string | null; owner: string | null };
  employeeReport: unknown | null;
  adminReport: unknown | null;
  // Skill-pack notes carried into the technician handoff (014). Without these a
  // technician receives evidence but not the constraints that protect the
  // employee's work — e.g. "do not reset the profile before backing up the Tool
  // Chest", which is the single most important instruction on that case.
  technicianNotes: {
    safetyConstraints: string[];
    stillUnknown: string[];
    recommendedNextStep: string[];
  } | null;
  auditRefs: string[];

  // What Watson still needs from the employee (drives one-question-at-a-time).
  needs: string[];
  // Facts already known so Watson never re-asks.
  known: Record<string, unknown>;
}

// ------------------------------------------------------------
// Store (repository over db()).
// ------------------------------------------------------------
function all(): WatsonCase[] {
  return db().cases;
}

export function createCase(input: {
  actor: Actor;
  platform: Platform;
  deviceContext?: { label: string; managed: boolean } | null;
  originalStatement: string;
}): WatsonCase {
  const now = nowIso();
  const c: WatsonCase = {
    caseId: uuid(),
    shortId: 'WC-' + Math.floor(1000 + all().length + 1),
    employeeId: input.actor.id,
    employeeEmail: input.actor.email,
    createdAt: now,
    updatedAt: now,
    platform: input.platform,
    deviceContext: input.deviceContext ?? null,
    scenario: 'unknown',
    problemSummary: '',
    originalStatement: input.originalStatement,
    messages: [],
    attachments: [],
    businessImpact: 'individual',
    urgency: 'normal',
    priority: 'normal',
    state: 'investigating',
    diagnosticPlan: [],
    hypotheses: [],
    evidence: [],
    confidence: null,
    proposedSolution: null,
    estimate: null,
    tripleCheck: null,
    approval: { required: false, level: 'none', state: 'none' },
    runs: [],
    verification: { systemVerified: false, functionalVerified: false },
    escalation: { escalated: false },
    assigned: { queue: null, owner: null },
    employeeReport: null,
    adminReport: null,
    technicianNotes: null,
    auditRefs: [],
    needs: [],
    known: {}
  };
  all().push(c);
  save();
  return c;
}

export function getCase(caseId: string): WatsonCase | null {
  return all().find((c) => c.caseId === caseId) ?? null;
}

// Employee-scoped read: only the owner (or an admin) may load a case.
export function getCaseForActor(caseId: string, actor: Actor): WatsonCase | null {
  const c = getCase(caseId);
  if (!c) return null;
  if (c.employeeId === actor.id) return c;
  if (actor.role === 'admin' || actor.role === 'owner') return c;
  return null; // no cross-employee access
}

export function listCasesForEmployee(actor: Actor): WatsonCase[] {
  return all().filter((c) => c.employeeId === actor.id).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

// The single most-recent OPEN case for an employee (resume without repeating).
export function currentOpenCase(actor: Actor): WatsonCase | null {
  const open = listCasesForEmployee(actor).filter((c) => !['resolved', 'closed'].includes(c.state));
  return open[0] ?? null;
}

export function listAllCases(): WatsonCase[] {
  return [...all()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function touch(c: WatsonCase): WatsonCase {
  c.updatedAt = nowIso();
  save();
  return c;
}

// Employee-safe projection: transcript + plain-language plan/cause/solution +
// status. Excludes gate reason codes, admin report, and any internal detail.
export function toEmployeeView(c: WatsonCase) {
  return {
    caseId: c.caseId,
    shortId: c.shortId,
    state: c.state,
    problem: c.problemSummary,
    platform: c.platform,
    messages: c.messages,
    attachments: c.attachments,
    plan: c.diagnosticPlan,
    checks: c.evidence.map((e) => ({ check: e.check, summary: e.summary })),
    likelyCause: c.hypotheses.find((h) => h.primary)?.label ?? null,
    confidence: c.confidence,
    proposedSolution: c.proposedSolution,
    estimate: c.estimate,
    approval: c.approval,
    verification: c.verification,
    escalated: c.escalation.escalated,
    employeeReport: c.employeeReport,
    needs: c.needs
  };
}

// Admin projection: the structured case for the support queue / case detail.
export function toAdminView(c: WatsonCase) {
  return {
    caseId: c.caseId,
    shortId: c.shortId,
    employeeId: c.employeeId,
    employeeEmail: c.employeeEmail,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    platform: c.platform,
    device: c.deviceContext?.label ?? 'unknown',
    scenario: c.scenario,
    problem: c.problemSummary,
    priority: c.priority,
    businessImpact: c.businessImpact,
    state: c.state,
    confidence: c.confidence,
    messages: c.messages,
    diagnosticPlan: c.diagnosticPlan,
    evidence: c.evidence,
    hypotheses: c.hypotheses,
    tripleCheck: c.tripleCheck,
    proposedSolution: c.proposedSolution,
    estimate: c.estimate,
    approval: c.approval,
    runs: c.runs,
    verification: c.verification,
    escalation: c.escalation,
    assigned: c.assigned,
    employeeReport: c.employeeReport,
    adminReport: c.adminReport,
    auditRefs: c.auditRefs
  };
}

// Compact queue row for the admin list.
export function toQueueRow(c: WatsonCase) {
  return {
    caseId: c.caseId,
    shortId: c.shortId,
    employee: c.employeeEmail ?? c.employeeId,
    device: c.deviceContext?.label ?? 'unknown',
    platform: c.platform,
    summary: c.problemSummary,
    state: c.state,
    confidence: c.confidence,
    priority: c.priority,
    expectedResponse: c.estimate?.responseLabel ?? null,
    estimatedRepair: c.estimate?.label ?? null,
    queue: c.assigned.queue,
    approvalRequired: c.approval.required
  };
}

// Case-scoped audit — records outcome + identifiers only (never transcript text,
// secrets, tokens, or raw payloads).
export function auditCase(actor: Actor, action: AuditEventType, c: WatsonCase, meta: Record<string, unknown> = {}): void {
  const entry = writeAudit({
    actorType: actor.type,
    actorId: actor.id,
    action,
    targetType: 'watson_case',
    targetId: c.shortId,
    metadata: { scenario: c.scenario, state: c.state, ...meta }
  });
  c.auditRefs.push(entry.id);
}
