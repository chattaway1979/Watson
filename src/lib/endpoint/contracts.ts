// ============================================================
// Watson Remote IT Operator — Core Contracts
// ------------------------------------------------------------
// Authoritative typed contracts (architecture doc 02). No arbitrary
// command text is accepted anywhere in these interfaces. The LLM may
// interpret and explain; it may NOT execute — all side effects flow
// through deterministic code over these typed shapes.
// ============================================================

export type RiskTier = 'low' | 'elevated' | 'critical';
export type ApprovalLevel = 'none' | 'employee' | 'it_approver' | 'owner';

// ---- Identity / authority ---------------------------------
export type Authority = 'employee' | 'it_approver' | 'owner' | 'system';

export interface Actor {
  actorId: string;
  tenantId: string;
  authority: Authority;
  displayName?: string;
}

// ---- Devices ----------------------------------------------
export interface EndpointDevice {
  tenantId: string;
  deviceId: string;
  provider: 'intune' | 'rmm' | 'simulator';
  hostname: string;
  platform: 'windows' | 'macos' | 'ios' | 'ipados';
  assignedUserId?: string;
  online: boolean;
  lastSeenAt: string;
  managementState: 'managed' | 'partially_managed' | 'unmanaged';
}

// ---- Evidence ---------------------------------------------
export interface EvidenceRequest {
  requestId: string;
  caseId: string;
  deviceId: string;
  evidenceType: string;
  parameters: Record<string, string | number | boolean>;
  timeoutSeconds: number;
}

export type EvidenceStatus = 'succeeded' | 'failed' | 'unavailable' | 'timed_out';

export interface EvidenceResult {
  requestId: string;
  collectedAt: string;
  source: string; // e.g. 'simulator', 'intune', 'rmm' — surfaced to admins, never as an internal engine label to employees
  status: EvidenceStatus;
  facts: Record<string, unknown>;
  redactions: string[];
  provenance: {
    provider: string;
    commandId?: string;
    correlationId?: string;
    simulated?: boolean;
  };
}

// ---- Actions ----------------------------------------------
export interface ActionDefinition {
  actionId: string;
  displayName: string;
  kind: 'read_only' | 'write';
  platform: string[];
  riskTier: RiskTier;
  approvalLevel: ApprovalLevel;
  requiredAuthority: Authority; // minimum authority to REQUEST/queue
  allowedParameters: Record<string, ParameterSpec>;
  preconditions: string[];
  timeoutSeconds: number;
  verification: string[];
  rollbackOrCompensation: string[];
  auditFields: string[];
  // Whether this action changes the computer (drives employee-visible disclosure).
  changesDevice: boolean;
  testOnly?: boolean; // refused unless WATSON_ALLOW_TESTONLY=true (never production)
}

export interface ParameterSpec {
  type: 'string' | 'number' | 'boolean' | 'enum';
  required: boolean;
  enum?: string[];
  maxLength?: number;
  description: string;
}

export interface ActionRequest {
  requestId: string;
  caseId: string;
  actorId: string;
  deviceId: string;
  actionId: string;
  parameters: Record<string, unknown>;
  approvalId?: string;
}

export type ActionStatus = 'succeeded' | 'failed' | 'denied' | 'timed_out' | 'canceled';
export type VerificationStatus = 'passed' | 'failed' | 'not_run';

export interface ActionResult {
  requestId: string;
  status: ActionStatus;
  startedAt: string;
  completedAt: string;
  evidence: EvidenceResult[];
  verificationStatus: VerificationStatus;
  reason?: string; // safe, non-sensitive explanation (e.g. denial reason category)
}

// ---- The vendor-neutral endpoint port ---------------------
export interface EndpointOperationsPort {
  readonly providerId: string;
  readonly simulated: boolean;
  resolveDevicesForUser(tenantId: string, userId: string): Promise<EndpointDevice[]>;
  collectEvidence(request: EvidenceRequest): Promise<EvidenceResult>;
  executeAction(request: ActionRequest): Promise<ActionResult>;
  cancelAction(requestId: string): Promise<void>;
}

// ============================================================
// Case / event-sourcing / hypothesis / escalation
// ============================================================
export type CaseState =
  | 'reported'
  | 'identity_resolved'
  | 'device_resolved'
  | 'inspecting'
  | 'diagnosing'
  | 'awaiting_employee_approval'
  | 'awaiting_admin_approval'
  | 'executing'
  | 'verifying'
  | 'resolved'
  | 'escalated'
  | 'blocked'
  | 'reopened'
  | 'closed';

export type EndpointEventType =
  | 'issue_reported'
  | 'identity_resolved'
  | 'device_selected'
  | 'evidence_requested'
  | 'evidence_received'
  | 'hypothesis_updated'
  | 'question_asked'
  | 'action_proposed'
  | 'approval_requested'
  | 'approval_granted'
  | 'approval_denied'
  | 'action_denied'
  | 'action_executed'
  | 'verification_completed'
  | 'escalation_created'
  | 'issue_resolved'
  | 'issue_reopened'
  | 'session_canceled'
  | 'state_changed';

export interface EndpointEvent {
  eventId: string;
  caseId: string;
  tenantId: string;
  type: EndpointEventType;
  actorId: string;
  actorAuthority: Authority;
  deviceId?: string;
  at: string;
  data: Record<string, unknown>; // never contains secrets/tokens/passwords
}

export interface Hypothesis {
  id: string;
  label: string; // employee-safe cause label
  score: number; // 0..1 confidence from evidence
  rationale: string; // evidence-grounded, employee-safe
  supportingFacts: string[];
  recommendedActionId?: string;
}

export interface EscalationPackage {
  caseId: string;
  createdAt: string;
  complaint: string;
  employee: { actorId: string; tenantId: string; displayName?: string };
  device: EndpointDevice | null;
  evidence: EvidenceResult[];
  hypotheses: Hypothesis[];
  actionsAttempted: Array<{ actionId: string; status: ActionStatus; verificationStatus: VerificationStatus; at: string }>;
  finalState: CaseState;
  nextRecommendedTechnicianStep: string;
  simulated: boolean;
}

// Employee-facing message — deliberately free of internal engine labels.
export interface EmployeeMessage {
  text: string;
  connectionState: 'connecting' | 'connected' | 'inspecting' | 'working' | 'verifying' | 'done' | 'offline';
  changesDeviceNext: boolean;
  approvalRequested: boolean;
  verificationPassed: boolean | null;
  simulated: boolean;
  stopAvailable: boolean;
}

export interface WatsonCase {
  caseId: string;
  tenantId: string;
  complaint: string;
  playbookId: string;
  actor: Actor | null;
  device: EndpointDevice | null;
  state: CaseState;
  evidence: EvidenceResult[];
  hypotheses: Hypothesis[];
  actions: Array<{ actionId: string; status: ActionStatus; verificationStatus: VerificationStatus; requestId: string; at: string }>;
  question: string | null;
  createdAt: string;
  updatedAt: string;
  canceled: boolean;
  simulated: boolean;
}
