// ============================================================
// Watson Remote IT Operator — Orchestrator (case state machine)
// ------------------------------------------------------------
// Runs the default loop:
//   identify -> connect -> inspect -> diagnose -> authorize
//   -> remediate -> verify -> report
// Inspects BEFORE asking questions. Asks at most one focused
// question only when evidence cannot answer it. A case can only
// reach 'resolved' via passed verification. The LLM does not run
// anything here — the deterministic executor does.
// ============================================================
import type {
  Actor, EndpointOperationsPort, WatsonCase, CaseState, EmployeeMessage, EscalationPackage, EndpointDevice
} from './contracts';
import { createExecutor } from './executor';
import { getAction } from './catalog';
import { grantApproval } from './policy';
import { appendEvent } from './events';
import { TEAMS_PLAYBOOK_ID, TEAMS_EVIDENCE_PLAN, mergeTeamsFacts, rankTeamsHypotheses } from './playbook-teams';
import { buildEscalation, nextTechnicianStep } from './escalation';
import * as render from './render';

let caseSeq = 0;

export interface OperatorResult {
  case: WatsonCase;
  messages: EmployeeMessage[];
  escalation: EscalationPackage | null;
}

export interface HandleOptions {
  consent?: boolean;        // employee consent for a low-risk device change (default true)
  cancelBeforeAction?: boolean; // simulate emergency stop before remediation
}

export function createOperator(port: EndpointOperationsPort) {
  const executor = createExecutor(port);

  function newCase(actor: Actor, complaint: string): WatsonCase {
    caseSeq += 1;
    return {
      caseId: `case_${caseSeq.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      tenantId: actor.tenantId,
      complaint,
      playbookId: TEAMS_PLAYBOOK_ID,
      actor,
      device: null,
      state: 'reported',
      evidence: [],
      hypotheses: [],
      actions: [],
      question: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      canceled: false,
      simulated: port.simulated
    };
  }

  function setState(wcase: WatsonCase, state: CaseState) {
    const from = wcase.state;
    wcase.state = state;
    wcase.updatedAt = new Date().toISOString();
    appendEvent({ caseId: wcase.caseId, tenantId: wcase.tenantId, type: 'state_changed', actorId: wcase.actor?.actorId ?? 'system', actorAuthority: wcase.actor?.authority ?? 'system', deviceId: wcase.device?.deviceId, data: { from, to: state } });
  }

  function chooseDevice(devices: EndpointDevice[], actor: Actor): EndpointDevice | null {
    if (devices.length === 0) return null;
    const assignedOnline = devices.find((d) => d.assignedUserId === actor.actorId && d.online);
    if (assignedOnline) return assignedOnline;
    const assigned = devices.find((d) => d.assignedUserId === actor.actorId);
    return assigned ?? devices[0];
  }

  async function handleTeamsFreezing(actor: Actor, complaint: string, opts: HandleOptions = {}): Promise<OperatorResult> {
    const messages: EmployeeMessage[] = [];
    const wcase = newCase(actor, complaint);
    appendEvent({ caseId: wcase.caseId, tenantId: wcase.tenantId, type: 'issue_reported', actorId: actor.actorId, actorAuthority: actor.authority, data: { complaint } });

    // identify
    setState(wcase, 'identity_resolved');
    appendEvent({ caseId: wcase.caseId, tenantId: wcase.tenantId, type: 'identity_resolved', actorId: actor.actorId, actorAuthority: actor.authority, data: { actorId: actor.actorId } });

    // connect / resolve device
    const devices = await port.resolveDevicesForUser(actor.tenantId, actor.actorId);
    wcase.device = chooseDevice(devices, actor);
    if (!wcase.device) {
      setState(wcase, 'blocked');
      wcase.hypotheses = rankTeamsHypotheses(mergeTeamsFacts([]));
      const esc = buildEscalation(wcase);
      messages.push(render.renderUnresolvedEscalation(wcase, wcase.hypotheses[0], esc.nextRecommendedTechnicianStep));
      appendEvent({ caseId: wcase.caseId, tenantId: wcase.tenantId, type: 'escalation_created', actorId: 'system', actorAuthority: 'system', data: { reason: 'no_device' } });
      return { case: wcase, messages, escalation: esc };
    }
    appendEvent({ caseId: wcase.caseId, tenantId: wcase.tenantId, type: 'device_selected', actorId: actor.actorId, actorAuthority: actor.authority, deviceId: wcase.device.deviceId, data: { hostname: wcase.device.hostname, online: wcase.device.online } });
    setState(wcase, 'device_resolved');
    messages.push(render.renderConnecting(wcase));

    // inspect (evidence BEFORE questions)
    setState(wcase, 'inspecting');
    messages.push(render.renderInspecting(wcase));
    for (const evidenceType of TEAMS_EVIDENCE_PLAN) {
      const result = await executor.collectEvidence(actor, wcase, evidenceType, evidenceType === 'event_logs' ? { logName: 'Application', maxEntries: 5 } : evidenceType === 'network_health' ? { target: 'm365' } : {});
      wcase.evidence.push(result);
    }

    // diagnose
    setState(wcase, 'diagnosing');
    const merged = mergeTeamsFacts(wcase.evidence);
    wcase.hypotheses = rankTeamsHypotheses(merged);
    const top = wcase.hypotheses[0];
    appendEvent({ caseId: wcase.caseId, tenantId: wcase.tenantId, type: 'hypothesis_updated', actorId: 'system', actorAuthority: 'system', deviceId: wcase.device.deviceId, data: { top: top.id, score: top.score, hypotheses: wcase.hypotheses.map((h) => ({ id: h.id, score: h.score })) } });
    messages.push(render.renderDiagnosis(wcase, top));

    // emergency stop before remediation
    if (opts.cancelBeforeAction) {
      wcase.canceled = true;
      appendEvent({ caseId: wcase.caseId, tenantId: wcase.tenantId, type: 'session_canceled', actorId: actor.actorId, actorAuthority: actor.authority, data: { phase: 'before_action' } });
      setState(wcase, 'blocked');
      messages.push(render.renderStopped(wcase));
      return { case: wcase, messages, escalation: null };
    }

    const actionId = top.recommendedActionId;
    if (!actionId) {
      // No low-risk device action fits -> escalate with full package.
      setState(wcase, 'escalated');
      const esc = buildEscalation(wcase);
      appendEvent({ caseId: wcase.caseId, tenantId: wcase.tenantId, type: 'escalation_created', actorId: 'system', actorAuthority: 'system', deviceId: wcase.device.deviceId, data: { top: top.id } });
      messages.push(render.renderUnresolvedEscalation(wcase, top, esc.nextRecommendedTechnicianStep));
      return { case: wcase, messages, escalation: esc };
    }

    const def = getAction(actionId)!;

    // authorize (ask permission only when policy requires it)
    let approvalId: string | undefined;
    if (def.approvalLevel !== 'none') {
      setState(wcase, 'awaiting_employee_approval');
      appendEvent({ caseId: wcase.caseId, tenantId: wcase.tenantId, type: 'approval_requested', actorId: actor.actorId, actorAuthority: actor.authority, deviceId: wcase.device.deviceId, data: { actionId } });
      messages.push(render.renderApprovalRequest(wcase, actionId));
      const consent = opts.consent ?? true;
      if (!consent) {
        appendEvent({ caseId: wcase.caseId, tenantId: wcase.tenantId, type: 'approval_denied', actorId: actor.actorId, actorAuthority: actor.authority, deviceId: wcase.device.deviceId, data: { actionId, by: 'employee' } });
        setState(wcase, 'blocked');
        messages.push(render.renderStopped(wcase));
        return { case: wcase, messages, escalation: buildEscalation(wcase) };
      }
      const granted = grantApproval({ caseId: wcase.caseId, actionId, requesterActorId: actor.actorId, grantedBy: actor });
      if (!granted.ok) {
        setState(wcase, 'blocked');
        messages.push(render.renderStopped(wcase));
        return { case: wcase, messages, escalation: buildEscalation(wcase) };
      }
      approvalId = granted.approval.approvalId;
      appendEvent({ caseId: wcase.caseId, tenantId: wcase.tenantId, type: 'approval_granted', actorId: actor.actorId, actorAuthority: actor.authority, deviceId: wcase.device.deviceId, data: { actionId, approvalId } });
    }

    // remediate
    setState(wcase, 'executing');
    const result = await executor.runAction(actor, wcase, actionId, {}, approvalId);
    wcase.actions.push({ actionId, status: result.status, verificationStatus: result.verificationStatus, requestId: result.requestId, at: new Date().toISOString() });

    // verify -> report
    setState(wcase, 'verifying');
    if (result.status === 'succeeded' && result.verificationStatus === 'passed') {
      setState(wcase, 'resolved');
      appendEvent({ caseId: wcase.caseId, tenantId: wcase.tenantId, type: 'issue_resolved', actorId: actor.actorId, actorAuthority: actor.authority, deviceId: wcase.device.deviceId, data: { actionId } });
      messages.push(render.renderResolved(wcase, actionId, result));
      return { case: wcase, messages, escalation: null };
    }

    // verification failed (or denied/timeout) -> unresolved -> escalate
    setState(wcase, 'escalated');
    const esc = buildEscalation(wcase);
    appendEvent({ caseId: wcase.caseId, tenantId: wcase.tenantId, type: 'escalation_created', actorId: 'system', actorAuthority: 'system', deviceId: wcase.device.deviceId, data: { top: top.id, actionId, actionStatus: result.status, verification: result.verificationStatus } });
    messages.push(render.renderUnresolvedEscalation(wcase, top, esc.nextRecommendedTechnicianStep));
    return { case: wcase, messages, escalation: esc };
  }

  return { handleTeamsFreezing, executor, nextTechnicianStep };
}
