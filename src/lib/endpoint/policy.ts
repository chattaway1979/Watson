// ============================================================
// Watson Remote IT Operator — Deterministic Policy Gate
// ------------------------------------------------------------
// Deny-by-default. Every side effect is validated here BEFORE the
// endpoint port is touched. The LLM never reaches this layer with
// executable content: parameters are typed + allowlisted, and any
// command-like value is rejected. Risk and approval floors are
// enforced in code and cannot be downgraded by a request.
// ============================================================
import type {
  Actor, Authority, ActionDefinition, ActionRequest, EndpointDevice, ApprovalLevel, ParameterSpec
} from './contracts';
import { getAction, isAllowlistedAction, isAllowedEvidenceType } from './catalog';

export interface PolicyDecision {
  allowed: boolean;
  reason: string;      // safe category, employee-neutral
  category:
    | 'permitted'
    | 'unknown_action'
    | 'unknown_evidence'
    | 'canceled'
    | 'tenant_mismatch'
    | 'device_not_assigned'
    | 'device_offline'
    | 'device_unmanaged'
    | 'insufficient_authority'
    | 'invalid_parameters'
    | 'command_injection_blocked'
    | 'approval_required'
    | 'invalid_approval'
    | 'self_approval_blocked'
    | 'approval_downgrade_blocked';
}

const AUTHORITY_RANK: Record<Authority, number> = { system: 100, owner: 90, it_approver: 80, employee: 10 };
const APPROVAL_MIN_RANK: Record<ApprovalLevel, number> = { none: 0, employee: 10, it_approver: 80, owner: 90 };

function rank(a: Authority): number { return AUTHORITY_RANK[a] ?? 0; }

// Any parameter VALUE that looks like a command / script / shell is rejected.
const COMMAND_LIKE = /(;|\||&&|`|\$\(|<\(|\bpowershell\b|\bcmd\b|\bbash\b|\bInvoke-|\bStart-Process\b|\brm\b\s|\bdel\b\s|\bformat\b|\bnet\s+user\b|\bregedit\b|-EncodedCommand|iex\b|curl\s|wget\s)/i;

// ---- Typed parameter validation ---------------------------
export function validateParameters(def: ActionDefinition, params: Record<string, unknown>): PolicyDecision {
  const allowed = def.allowedParameters;
  // Reject any parameter not on the allowlist (deny-by-default for inputs).
  for (const key of Object.keys(params ?? {})) {
    if (!(key in allowed)) {
      return { allowed: false, reason: `parameter '${key}' is not permitted`, category: 'invalid_parameters' };
    }
  }
  for (const [key, spec] of Object.entries(allowed)) {
    const present = params && key in params;
    const value = params?.[key];
    if (spec.required && !present) {
      return { allowed: false, reason: `missing required parameter '${key}'`, category: 'invalid_parameters' };
    }
    if (!present) continue;
    const typeOk = checkType(spec, value);
    if (!typeOk) return { allowed: false, reason: `parameter '${key}' has invalid type`, category: 'invalid_parameters' };
    if (spec.type === 'enum' && !(spec.enum ?? []).includes(String(value))) {
      return { allowed: false, reason: `parameter '${key}' is not an allowed value`, category: 'invalid_parameters' };
    }
    if (typeof value === 'string') {
      if (spec.maxLength && value.length > spec.maxLength) {
        return { allowed: false, reason: `parameter '${key}' exceeds max length`, category: 'invalid_parameters' };
      }
      if (COMMAND_LIKE.test(value)) {
        return { allowed: false, reason: 'command-like input rejected', category: 'command_injection_blocked' };
      }
    }
  }
  return { allowed: true, reason: 'parameters valid', category: 'permitted' };
}

function checkType(spec: ParameterSpec, value: unknown): boolean {
  switch (spec.type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'enum': return typeof value === 'string';
    default: return false;
  }
}

// ---- Approvals store (deterministic, in-memory) -----------
export interface ApprovalGrant {
  approvalId: string;
  caseId: string;
  actionId: string;
  requesterActorId: string;
  grantedByActorId: string;
  grantedByAuthority: Authority;
  at: string;
}

const APPROVALS = new Map<string, ApprovalGrant>();

// Granting is itself gated: the grantor's authority must satisfy the action's
// approval level, and privileged approvals cannot be self-granted by the requester.
export function grantApproval(input: {
  caseId: string; actionId: string; requesterActorId: string; grantedBy: Actor;
}): { ok: true; approval: ApprovalGrant } | { ok: false; decision: PolicyDecision } {
  const def = getAction(input.actionId);
  if (!def) return { ok: false, decision: { allowed: false, reason: 'unknown action', category: 'unknown_action' } };
  const level = def.approvalLevel;
  if (rank(input.grantedBy.authority) < APPROVAL_MIN_RANK[level]) {
    return { ok: false, decision: { allowed: false, reason: 'approver authority insufficient', category: 'invalid_approval' } };
  }
  // Employees may never approve privileged (it_approver/owner) actions.
  if ((level === 'it_approver' || level === 'owner') && input.grantedBy.authority === 'employee') {
    return { ok: false, decision: { allowed: false, reason: 'employee cannot approve privileged action', category: 'insufficient_authority' } };
  }
  // No self-approval for privileged actions.
  if ((level === 'it_approver' || level === 'owner') && input.grantedBy.actorId === input.requesterActorId) {
    return { ok: false, decision: { allowed: false, reason: 'self-approval blocked', category: 'self_approval_blocked' } };
  }
  const approval: ApprovalGrant = {
    approvalId: `apr_${Math.random().toString(36).slice(2, 10)}`,
    caseId: input.caseId,
    actionId: input.actionId,
    requesterActorId: input.requesterActorId,
    grantedByActorId: input.grantedBy.actorId,
    grantedByAuthority: input.grantedBy.authority,
    at: new Date().toISOString()
  };
  APPROVALS.set(approval.approvalId, approval);
  return { ok: true, approval };
}

export function getApproval(approvalId: string): ApprovalGrant | undefined {
  return APPROVALS.get(approvalId);
}

export function __resetApprovalsForTests(): void { APPROVALS.clear(); }

// ---- Evidence gate (read-only) ----------------------------
export function canCollectEvidence(actor: Actor, evidenceType: string, device: EndpointDevice | null, caseCanceled: boolean): PolicyDecision {
  if (caseCanceled) return { allowed: false, reason: 'session canceled', category: 'canceled' };
  if (!isAllowedEvidenceType(evidenceType)) return { allowed: false, reason: 'evidence type not supported', category: 'unknown_evidence' };
  if (!device) return { allowed: false, reason: 'no device', category: 'device_not_assigned' };
  if (device.tenantId !== actor.tenantId) return { allowed: false, reason: 'tenant mismatch', category: 'tenant_mismatch' };
  if (device.assignedUserId && device.assignedUserId !== actor.actorId && actor.authority === 'employee') {
    return { allowed: false, reason: 'device not assigned to employee', category: 'device_not_assigned' };
  }
  if (device.managementState === 'unmanaged') return { allowed: false, reason: 'device not managed', category: 'device_unmanaged' };
  return { allowed: true, reason: 'permitted', category: 'permitted' };
}

// ---- Action gate (the deterministic decision) -------------
export function canPerformAction(
  actor: Actor,
  request: ActionRequest,
  device: EndpointDevice | null,
  caseCanceled: boolean
): PolicyDecision {
  // 0) Emergency stop / cancellation.
  if (caseCanceled) return { allowed: false, reason: 'session canceled', category: 'canceled' };

  // 1) Allowlist (deny-by-default).
  if (!isAllowlistedAction(request.actionId)) {
    return { allowed: false, reason: 'action is not on the allowlist', category: 'unknown_action' };
  }
  const def = getAction(request.actionId)!;

  // 2) Device + tenant + assignment binding.
  if (!device) return { allowed: false, reason: 'no device resolved', category: 'device_not_assigned' };
  if (device.tenantId !== actor.tenantId) return { allowed: false, reason: 'tenant mismatch', category: 'tenant_mismatch' };
  if (device.assignedUserId && device.assignedUserId !== actor.actorId && actor.authority === 'employee') {
    return { allowed: false, reason: 'device not assigned to employee', category: 'device_not_assigned' };
  }
  if (device.managementState === 'unmanaged') return { allowed: false, reason: 'device not managed', category: 'device_unmanaged' };
  if (def.changesDevice && !device.online) return { allowed: false, reason: 'device offline', category: 'device_offline' };

  // 3) Authority floor to REQUEST/queue.
  if (rank(actor.authority) < rank(def.requiredAuthority)) {
    return { allowed: false, reason: 'insufficient authority to request action', category: 'insufficient_authority' };
  }

  // 4) Typed parameter validation (rejects unknown params + command-like values).
  const paramCheck = validateParameters(def, request.parameters ?? {});
  if (!paramCheck.allowed) return paramCheck;

  // 5) Approval floor (cannot be downgraded — level is read from the catalog).
  if (def.approvalLevel !== 'none') {
    if (!request.approvalId) return { allowed: false, reason: 'approval required', category: 'approval_required' };
    const grant = getApproval(request.approvalId);
    if (!grant) return { allowed: false, reason: 'approval not found', category: 'invalid_approval' };
    if (grant.actionId !== def.actionId || grant.caseId !== request.caseId) {
      return { allowed: false, reason: 'approval does not match this action/case', category: 'invalid_approval' };
    }
    if (rank(grant.grantedByAuthority) < APPROVAL_MIN_RANK[def.approvalLevel]) {
      return { allowed: false, reason: 'approver authority insufficient', category: 'approval_downgrade_blocked' };
    }
    if ((def.approvalLevel === 'it_approver' || def.approvalLevel === 'owner') && grant.grantedByActorId === request.actorId) {
      return { allowed: false, reason: 'self-approval blocked', category: 'self_approval_blocked' };
    }
    if ((def.approvalLevel === 'it_approver' || def.approvalLevel === 'owner') && grant.grantedByAuthority === 'employee') {
      return { allowed: false, reason: 'employee cannot approve privileged action', category: 'insufficient_authority' };
    }
  }

  return { allowed: true, reason: 'permitted', category: 'permitted' };
}
