// ============================================================
// Watson — H&R AI IT Agent : Tool Gateway
// ------------------------------------------------------------
// The ONLY path through which actions are invoked. Enforces:
//   1. policy (canPerformAction)
//   2. approval routing for high/critical actions
//   3. mock-only execution for safe actions
//   4. the live-execution master gate (always off here)
// Future Microsoft Graph / Intune / NinjaOne / Atera adapters
// register here without weakening these guarantees.
// ============================================================
import { canPerformAction, isLiveExternalExecutionEnabled } from './policy';
import { getAction } from './action-registry';
import { createApprovalRequest } from './approval-engine';
import { mockM365 } from './mock-microsoft365';
import { mockDevice } from './mock-device-management';
import { searchArticles, getArticleBySlug } from './knowledge';
import { writeAudit } from './audit';
import type { Actor } from './types';

export type GatewayOutcome =
  | { kind: 'denied'; reason: string }
  | { kind: 'approval_required'; approvalId: string; approvalShortId: string; reason: string }
  | { kind: 'live_blocked'; reason: string }
  | { kind: 'mock_result'; result: unknown }
  | { kind: 'read_result'; result: unknown };

export interface GatewayInput {
  actionKey: string;
  input: Record<string, unknown>;
  ticketId?: string | null;
}

export function invokeAction(actor: Actor, req: GatewayInput): GatewayOutcome {
  const def = getAction(req.actionKey);
  if (!def) return { kind: 'denied', reason: `Unknown action: ${req.actionKey}` };

  const decision = canPerformAction(actor, req.actionKey, req.input.email ?? req.input.deviceId, req.input);

  writeAudit({
    actorType: actor.type, actorId: actor.id, action: 'policy_decision_recorded',
    targetType: 'action', targetId: def.key,
    metadata: { allowed: decision.allowed, requiresApproval: decision.requiresApproval, reason: decision.reason, riskLevel: def.riskLevel }
  });

  // Critical / live-only actions: queue approval, never execute.
  if (def.execMode === 'future_live') {
    const ar = createApprovalRequest(actor, {
      actionKey: def.key,
      targetType: def.connectorTarget,
      targetId: String(req.input.email ?? req.input.deviceId ?? req.input.mailbox ?? 'n/a'),
      payload: req.input,
      ticketId: req.ticketId ?? null
    });
    return {
      kind: 'approval_required',
      approvalId: ar.id,
      approvalShortId: ar.shortId,
      reason: 'Critical action queued for owner/admin approval. Live execution is disabled.'
    };
  }

  if (!decision.allowed) {
    return { kind: 'denied', reason: decision.reason };
  }

  // High-risk (or otherwise approval-required) → queue approval.
  if (decision.requiresApproval) {
    const ar = createApprovalRequest(actor, {
      actionKey: def.key,
      targetType: def.connectorTarget,
      targetId: String(req.input.email ?? req.input.deviceId ?? req.input.mailbox ?? 'n/a'),
      payload: req.input,
      ticketId: req.ticketId ?? null
    });
    return {
      kind: 'approval_required',
      approvalId: ar.id,
      approvalShortId: ar.shortId,
      reason: `${def.displayName} requires approval before any (simulated) execution.`
    };
  }

  // Safe path: read-only or medium mock execution.
  const out = runSafe(actor, def.key, req.input);
  if (out === LIVE_BLOCKED) return { kind: 'live_blocked', reason: 'Live execution disabled.' };
  const isRead = def.execMode === 'read_only';
  return isRead ? { kind: 'read_result', result: out } : { kind: 'mock_result', result: out };
}

const LIVE_BLOCKED = Symbol('live_blocked');

function runSafe(actor: Actor, key: string, input: Record<string, unknown>): unknown {
  const email = String(input.email ?? '');
  const deviceId = String(input.deviceId ?? '');
  switch (key) {
    case 'search_knowledge_base':
      return searchArticles(String(input.query ?? ''), { category: input.category as never, limit: 10 });
    case 'send_setup_instructions':
      return getArticleBySlug(String(input.slug ?? '')) ?? null;
    case 'lookup_user':
      return mockM365.lookupUser(email, actor);
    case 'check_license_status':
      return mockM365.checkLicenseStatus(email, actor);
    case 'check_mfa_status':
      return mockM365.checkMfaStatus(email, actor);
    case 'check_mailbox_status':
      return mockM365.checkMailboxStatus(email, actor);
    case 'check_group_membership':
      return mockM365.checkGroupMembership(email, actor);
    case 'lookup_device':
      return mockDevice.lookupDeviceByEmail(email, actor);
    case 'check_device_status':
      return mockDevice.checkDeviceStatus(deviceId, actor);
    case 'trigger_device_sync_mock':
      return mockDevice.triggerSyncMock(deviceId, actor);
    case 'collect_device_diagnostics_mock':
      return mockDevice.collectDiagnosticsMock(deviceId, actor);
    default:
      // Anything else is not safe-runnable here.
      if (isLiveExternalExecutionEnabled()) return LIVE_BLOCKED;
      return { note: `Action '${key}' is preparatory/approval-only and was not executed.` };
  }
}
