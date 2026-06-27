// ============================================================
// Watson — H&R AI IT Agent : Core Domain Types
// Pure TypeScript. No framework imports. Safe to import from
// server routes, the selftest harness, and (read-only) the UI.
// ============================================================

export type Role = 'employee' | 'manager' | 'admin' | 'owner' | 'agent' | 'system';

export type ActorType = 'user' | 'admin' | 'agent' | 'system';

export interface Actor {
  id: string;
  type: ActorType;
  role: Role;
  email?: string;
  displayName?: string;
}

// ---- Tickets ----------------------------------------------
export const TICKET_CATEGORIES = [
  'email_setup',
  'outlook',
  'teams',
  'onedrive',
  'password_mfa',
  'printer',
  'network',
  'device_slow',
  'device_access',
  'software_install',
  'sharepoint_access',
  'onboarding',
  'offboarding',
  'security',
  'other'
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export const TICKET_STATUSES = [
  'open',
  'triaged',
  'waiting_on_employee',
  'waiting_on_admin',
  'approval_required',
  'in_progress',
  'resolved',
  'closed',
  'cancelled'
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface TicketMessage {
  id: string;
  ticketId: string;
  authorType: ActorType;
  authorId: string;
  authorName?: string;
  body: string;
  internal: boolean; // internal admin note vs employee-visible
  createdAt: string;
}

export interface TicketEvent {
  id: string;
  ticketId: string;
  type: string; // e.g. status_changed, assigned, escalated
  actorType: ActorType;
  actorId: string;
  summary: string;
  data?: Record<string, unknown>;
  createdAt: string;
}

export interface RecommendedAction {
  actionKey: string;
  displayName: string;
  riskLevel: RiskLevel;
  requiresApproval: boolean;
  rationale: string;
  inputDraft?: Record<string, unknown>;
}

export interface Ticket {
  id: string;
  shortId: string; // e.g. WAT-1042
  subject: string;
  description: string;
  category: TicketCategory;
  status: TicketStatus;
  priority: Priority;
  requesterId: string;
  requesterEmail: string;
  requesterName?: string;
  assigneeId?: string | null;
  assigneeName?: string | null;
  aiDiagnosis?: AiDiagnosis | null;
  recommendedActions: RecommendedAction[];
  linkedApprovalIds: string[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
  triagedAt?: string | null;
  resolvedAt?: string | null;
  closedAt?: string | null;
}

// ---- AI / Triage ------------------------------------------
export interface AiDiagnosis {
  category: TicketCategory;
  priority: Priority;
  confidence: number; // 0..1
  likelyCauses: string[];
  summary: string;
  provider: string; // "deterministic" | "anthropic" | ...
  createdAt: string;
}

export interface TroubleshootingPlan {
  category: TicketCategory;
  priority: Priority;
  likelyCauses: string[];
  firstChecks: string[];
  steps: string[];
  whenToEscalate: string;
  recommendedActions: RecommendedAction[];
  relatedArticleSlugs: string[];
}

export interface TriageResult {
  diagnosis: AiDiagnosis;
  plan: TroubleshootingPlan;
}

// ---- Actions / Registry -----------------------------------
export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export type ActionExecMode =
  | 'read_only'      // safe lookups / reads (mock data)
  | 'preparatory'    // prepares a request/checklist, executes nothing external
  | 'mock_executable'// simulated execution against a mock connector
  | 'future_live';   // real external execution — DISABLED in this build

export type ConnectorTarget =
  | 'none'
  | 'microsoft365'
  | 'device_rmm'
  | 'knowledge_base'
  | 'ticketing'
  | 'internal';

export interface ActionDefinition {
  key: string;
  displayName: string;
  category: string;
  description: string;
  riskLevel: RiskLevel;
  requiredRole: Role; // minimum role allowed to invoke/queue
  requiresApproval: boolean;
  mockExecutable: boolean;
  liveExecutable: boolean; // always false in this build
  execMode: ActionExecMode;
  connectorTarget: ConnectorTarget;
  inputSchema: Record<string, string>;  // field -> type description
  resultSchema: Record<string, string>; // field -> type description
  auditBehavior: string;
}

// ---- Approvals --------------------------------------------
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface ApprovalRequest {
  id: string;
  shortId: string; // APR-1001
  actionKey: string;
  actionDisplayName: string;
  riskLevel: RiskLevel;
  ticketId?: string | null;
  requestedByType: ActorType;
  requestedById: string;
  requestedByName?: string;
  targetType: string;
  targetId: string;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  decidedByType?: ActorType;
  decidedById?: string;
  decidedByName?: string;
  decisionNote?: string;
  mockExecuted: boolean;
  mockResult?: Record<string, unknown> | null;
  createdAt: string;
  decidedAt?: string | null;
}

// ---- Knowledge --------------------------------------------
export type ArticleVisibility = 'public' | 'internal';

export interface KnowledgeArticle {
  id: string;
  slug: string;
  title: string;
  category: TicketCategory;
  summary: string;
  body: string; // markdown-ish plain text with numbered steps
  tags: string[];
  visibility: ArticleVisibility;
  createdAt: string;
  updatedAt: string;
}

// ---- Audit ------------------------------------------------
export const AUDIT_EVENTS = [
  'ticket_created',
  'ticket_updated',
  'ticket_status_changed',
  'ticket_assigned',
  'ticket_closed',
  'ticket_reopened',
  'ai_message_created',
  'agent_triage_completed',
  'agent_action_recommended',
  'approval_requested',
  'approval_approved',
  'approval_rejected',
  'mock_action_executed',
  'knowledge_article_created',
  'knowledge_article_updated',
  'admin_note_added',
  'policy_decision_recorded',
  'connector_mock_called'
] as const;
export type AuditEventType = (typeof AUDIT_EVENTS)[number];

export interface AuditLog {
  id: string;
  actorType: ActorType;
  actorId: string;
  action: AuditEventType;
  targetType: string;
  targetId: string;
  beforeState?: Record<string, unknown> | null;
  afterState?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
  createdAt: string;
}

// ---- Mock connector entities ------------------------------
export interface MockM365User {
  id: string;
  email: string;
  displayName: string;
  jobTitle: string;
  department: string;
  accountEnabled: boolean;
  licenses: string[];
  mfaEnabled: boolean;
  mfaMethods: string[];
  mailboxType: 'user' | 'shared';
  mailboxSizeGb: number;
  mailboxQuotaGb: number;
  groups: string[];
  lastSignIn: string;
}

export interface MockDevice {
  id: string;
  ownerEmail: string;
  deviceName: string;
  os: string;
  osVersion: string;
  serialNumber: string;
  lastCheckIn: string;
  diskFreeGb: number;
  diskTotalGb: number;
  antivirusStatus: 'healthy' | 'out_of_date' | 'disabled';
  patchStatus: 'up_to_date' | 'pending' | 'behind';
  complianceStatus: 'compliant' | 'non_compliant' | 'in_grace';
  remoteSupportAvailable: boolean;
  managedBy: 'intune_mock' | 'ninjaone_mock' | 'atera_mock' | 'unmanaged';
}

// ---- Policy decision --------------------------------------
export interface PolicyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
  riskLevel?: RiskLevel;
}
