// ============================================================
// Watson — H&R AI IT Agent : Policy / Permission Engine
// ------------------------------------------------------------
// Backend-owned authorization. The UI is NEVER the only gate.
// Decisions are derived from the action registry + role model.
// ============================================================
import type { Actor, ActionDefinition, PolicyDecision, Ticket } from './types';
import { ROLE_RANK, roleAtLeast, isLiveExternalExecutionEnabled } from './constants';
import { getAction } from './action-registry';

// ---- Live execution gate (re-exported for clarity) --------
export { isLiveExternalExecutionEnabled };

// ---- Approval requirement ---------------------------------
// High and critical actions ALWAYS require approval, regardless of
// the registry flag, as a defense-in-depth backstop.
export function requiresApproval(
  action: ActionDefinition,
  _actor: Actor,
  _target?: unknown,
  _context?: Record<string, unknown>
): boolean {
  if (action.riskLevel === 'high' || action.riskLevel === 'critical') return true;
  return action.requiresApproval;
}

// ---- Who may approve a given action -----------------------
// Critical actions require owner (or admin acting as owner-tier=80? -> no,
// critical requires owner-tier). High actions require admin or above.
export function canApproveAction(approver: Actor, action: ActionDefinition): boolean {
  // Watson / the agent can NEVER approve anything (including its own actions).
  if (approver.type === 'agent' || approver.role === 'agent') return false;
  if (action.riskLevel === 'critical') return roleAtLeast(approver.role, 'owner');
  if (action.riskLevel === 'high') return roleAtLeast(approver.role, 'admin');
  // medium/low typically don't need approval, but if queued, admin may decide.
  return roleAtLeast(approver.role, 'admin');
}

// ---- Core action authorization ----------------------------
export function canPerformAction(
  actor: Actor,
  actionKey: string,
  target?: unknown,
  context?: Record<string, unknown>
): PolicyDecision {
  const action = getAction(actionKey);
  if (!action) {
    return { allowed: false, requiresApproval: false, reason: `Unknown action: ${actionKey}` };
  }

  // The agent may PREPARE/RECOMMEND but never directly perform external/critical work.
  if ((actor.type === 'agent' || actor.role === 'agent')) {
    if (action.execMode === 'future_live' || action.riskLevel === 'critical') {
      return {
        allowed: false,
        requiresApproval: true,
        reason: 'Watson may recommend but cannot perform critical/live actions.',
        riskLevel: action.riskLevel
      };
    }
  }

  // Role floor check.
  if (!roleAtLeast(actor.role, action.requiredRole)) {
    return {
      allowed: false,
      requiresApproval: action.requiresApproval,
      reason: `Role '${actor.role}' is below required '${action.requiredRole}' for ${action.key}.`,
      riskLevel: action.riskLevel
    };
  }

  // Live execution is globally gated.
  if (action.execMode === 'future_live' && !isLiveExternalExecutionEnabled()) {
    return {
      allowed: false,
      requiresApproval: true,
      reason: 'Live external execution is disabled. Action can only be queued for approval.',
      riskLevel: action.riskLevel
    };
  }

  const needsApproval = requiresApproval(action, actor, target, context);
  return {
    allowed: true,
    requiresApproval: needsApproval,
    reason: needsApproval
      ? 'Permitted to queue; approval required before any (simulated) execution.'
      : 'Permitted.',
    riskLevel: action.riskLevel
  };
}

// ---- Ticket visibility ------------------------------------
export function canViewTicket(actor: Actor, ticket: Ticket): boolean {
  if (roleAtLeast(actor.role, 'admin')) return true; // admin/owner see all
  if (ticket.requesterId === actor.id) return true; // own ticket
  if (actor.role === 'manager' && ticket.assigneeId === actor.id) return true;
  // managers may view tickets they are assigned to manage (assignee model).
  return false;
}

export function canManageTicket(actor: Actor, ticket: Ticket): boolean {
  if (roleAtLeast(actor.role, 'admin')) return true;
  if (actor.role === 'manager' && ticket.assigneeId === actor.id) return true;
  return false;
}

export function canCreateLifecycleRequest(actor: Actor): boolean {
  // managers + admins + owners may create onboarding/offboarding requests
  return roleAtLeast(actor.role, 'manager');
}

// ---- Decision helper for selftests / audit ----------------
export function describeRole(actor: Actor): string {
  return `${actor.role}(rank=${ROLE_RANK[actor.role]})`;
}
