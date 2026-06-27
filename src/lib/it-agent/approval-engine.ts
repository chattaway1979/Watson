// ============================================================
// Watson — H&R AI IT Agent : Approval Engine
// ------------------------------------------------------------
// High/critical actions are NEVER executed directly. They are
// captured here as approval requests with the full proposed
// payload. A human (admin/owner) approves or rejects. On
// approval, ONLY a mock simulation runs (and only if the action
// is mockExecutable AND the live gate is off — which it is).
// Watson/the agent can NEVER approve.
// ============================================================
import { db, save, uuid, nowIso, nextId } from '../store/db';
import { writeAudit } from './audit';
import { getAction } from './action-registry';
import { canApproveAction, isLiveExternalExecutionEnabled } from './policy';
import { linkApproval } from './tickets';
import type { Actor, ApprovalRequest, ApprovalStatus } from './types';

function shortId(n: number): string {
  return `APR-${n}`;
}

export function createApprovalRequest(
  requester: Actor,
  input: { actionKey: string; targetType: string; targetId: string; payload: Record<string, unknown>; ticketId?: string | null }
): ApprovalRequest {
  const def = getAction(input.actionKey);
  if (!def) throw new Error(`Unknown action: ${input.actionKey}`);

  const n = nextId('approval');
  const req: ApprovalRequest = {
    id: uuid(),
    shortId: shortId(n),
    actionKey: def.key,
    actionDisplayName: def.displayName,
    riskLevel: def.riskLevel,
    ticketId: input.ticketId ?? null,
    requestedByType: requester.type,
    requestedById: requester.id,
    requestedByName: requester.displayName ?? requester.email,
    targetType: input.targetType,
    targetId: input.targetId,
    payload: input.payload,
    status: 'pending',
    mockExecuted: false,
    mockResult: null,
    createdAt: nowIso(),
    decidedAt: null
  };
  db().approvals.push(req);
  if (req.ticketId) linkApproval(req.ticketId, req.id);
  writeAudit({
    actorType: requester.type, actorId: requester.id, action: 'approval_requested',
    targetType: 'approval', targetId: req.shortId,
    metadata: { actionKey: def.key, riskLevel: def.riskLevel, ticketId: req.ticketId },
    afterState: { status: 'pending', payload: input.payload }
  });
  save();
  return req;
}

export function listApprovals(status?: ApprovalStatus): ApprovalRequest[] {
  let rows = [...db().approvals];
  if (status) rows = rows.filter((a) => a.status === status);
  return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function getApproval(id: string): ApprovalRequest | undefined {
  return db().approvals.find((a) => a.id === id || a.shortId === id);
}

export interface DecisionResult {
  approval: ApprovalRequest;
  mockExecuted: boolean;
  liveBlocked: boolean;
  message: string;
}

export function decideApproval(approver: Actor, id: string, decision: 'approved' | 'rejected', note?: string): DecisionResult {
  const req = getApproval(id);
  if (!req) throw new Error('Approval request not found');
  if (req.status !== 'pending') throw new Error(`Approval already ${req.status}`);

  const def = getAction(req.actionKey);
  if (!def) throw new Error('Action definition missing');

  // HARD RULE: the agent can never approve. Also enforce role/risk.
  if (approver.type === 'agent' || approver.role === 'agent') {
    throw new Error('Watson/agent is not permitted to approve actions.');
  }
  // An actor cannot approve their own request.
  if (approver.id === req.requestedById && approver.type === req.requestedByType) {
    throw new Error('You cannot approve your own request.');
  }
  if (!canApproveAction(approver, def)) {
    throw new Error(`Role '${approver.role}' cannot approve ${def.riskLevel}-risk action ${def.key}.`);
  }

  req.status = decision as ApprovalStatus;
  req.decidedByType = approver.type;
  req.decidedById = approver.id;
  req.decidedByName = approver.displayName ?? approver.email;
  req.decisionNote = note;
  req.decidedAt = nowIso();

  let mockExecuted = false;
  let liveBlocked = false;
  let message = '';

  if (decision === 'rejected') {
    writeAudit({
      actorType: approver.type, actorId: approver.id, action: 'approval_rejected',
      targetType: 'approval', targetId: req.shortId,
      beforeState: { status: 'pending' }, afterState: { status: 'rejected', note }
    });
    message = `Rejected ${def.displayName}. No action taken.`;
  } else {
    writeAudit({
      actorType: approver.type, actorId: approver.id, action: 'approval_approved',
      targetType: 'approval', targetId: req.shortId,
      beforeState: { status: 'pending' }, afterState: { status: 'approved', note }
    });

    // EXECUTION GATE — defense in depth.
    if (def.execMode === 'future_live' || !def.mockExecutable) {
      // Critical / live-only actions: NEVER execute in this build.
      liveBlocked = true;
      message = `Approved ${def.displayName}, but live execution is DISABLED in this build. Nothing was executed.`;
    } else if (isLiveExternalExecutionEnabled()) {
      // Would route to a live connector. The master switch is false in this build,
      // so this branch is unreachable; kept explicit for auditability.
      liveBlocked = true;
      message = `Approved, but live execution path is intentionally unavailable in this build.`;
    } else {
      // Safe simulated execution against mock connector.
      req.mockExecuted = true;
      req.mockResult = {
        simulated: true,
        action: def.key,
        target: req.targetId,
        executedAt: nowIso(),
        note: 'MOCK execution only — no external system was contacted.'
      };
      mockExecuted = true;
      writeAudit({
        actorType: approver.type, actorId: approver.id, action: 'mock_action_executed',
        targetType: 'approval', targetId: req.shortId,
        metadata: { actionKey: def.key, simulated: true }
      });
      message = `Approved ${def.displayName}. Simulated (mock) execution completed — no real system was changed.`;
    }
  }

  save();
  return { approval: req, mockExecuted, liveBlocked, message };
}
