// ============================================================
// Watson Remote IT Operator — Deterministic Executor + Verifier
// ------------------------------------------------------------
// The ONLY path from Watson to the endpoint. Enforces policy,
// timeouts, immutable audit events, and MANDATORY verification.
// It accepts a typed actionId + validated parameters — never any
// command/script text. Verification is computed by re-collecting
// evidence and evaluating the action's declared predicates, so a
// case can only be considered fixed on real (simulated) evidence.
// ============================================================
import type {
  Actor, EndpointOperationsPort, EvidenceRequest, EvidenceResult,
  ActionRequest, ActionResult, WatsonCase, VerificationStatus
} from './contracts';
import { getAction } from './catalog';
import { canCollectEvidence, canPerformAction } from './policy';
import { appendEvent } from './events';

let counter = 0;
const rid = (p: string) => `${p}_${(++counter).toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

async function withTimeout<T>(p: Promise<T>, seconds: number): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), Math.max(1, seconds * 1000));
  });
  const result = await Promise.race([p.then((value) => ({ timedOut: false as const, value })), timeout]);
  clearTimeout(timer!);
  return result;
}

export interface Executor {
  collectEvidence(actor: Actor, wcase: WatsonCase, evidenceType: string, parameters?: Record<string, string | number | boolean>): Promise<EvidenceResult>;
  runAction(actor: Actor, wcase: WatsonCase, actionId: string, parameters?: Record<string, unknown>, approvalId?: string): Promise<ActionResult>;
}

// ---- Verification predicate evaluators --------------------
// Each returns true/false from FRESH evidence facts. Unknown predicates
// fail closed (return false) so verification cannot silently pass.
type FactBag = { process?: Record<string, unknown>; teams?: Record<string, unknown>; network?: Record<string, unknown> };

const PREDICATES: Record<string, (f: FactBag, actionSucceeded: boolean) => boolean> = {
  teams_process_running: (f) => f.process?.state === 'running',
  teams_stable_10s: (f) => f.process?.state === 'running',
  teams_cache_rebuilt: (f) => f.teams?.cacheCorrupt === false,
  intune_sync_acknowledged: (_f, ok) => ok === true,
  network_healthy: (f) => f.network?.reachable === true
};

export function createExecutor(port: EndpointOperationsPort): Executor {
  async function collectEvidence(actor: Actor, wcase: WatsonCase, evidenceType: string, parameters: Record<string, string | number | boolean> = {}): Promise<EvidenceResult> {
    const decision = canCollectEvidence(actor, evidenceType, wcase.device, wcase.canceled);
    const requestId = rid('ev');
    appendEvent({ caseId: wcase.caseId, tenantId: wcase.tenantId, type: 'evidence_requested', actorId: actor.actorId, actorAuthority: actor.authority, deviceId: wcase.device?.deviceId, data: { evidenceType, allowed: decision.allowed, category: decision.category } });
    if (!decision.allowed) {
      const denied: EvidenceResult = { requestId, collectedAt: new Date().toISOString(), source: port.providerId, status: 'failed', facts: { denied: true, reason: decision.category }, redactions: [], provenance: { provider: port.providerId, simulated: port.simulated } };
      return denied;
    }
    const req: EvidenceRequest = { requestId, caseId: wcase.caseId, deviceId: wcase.device!.deviceId, evidenceType, parameters, timeoutSeconds: 30 };
    const raced = await withTimeout(port.collectEvidence(req), req.timeoutSeconds);
    const result: EvidenceResult = raced.timedOut
      ? { requestId, collectedAt: new Date().toISOString(), source: port.providerId, status: 'timed_out', facts: {}, redactions: [], provenance: { provider: port.providerId, simulated: port.simulated } }
      : raced.value;
    appendEvent({ caseId: wcase.caseId, tenantId: wcase.tenantId, type: 'evidence_received', actorId: actor.actorId, actorAuthority: actor.authority, deviceId: wcase.device?.deviceId, data: { evidenceType, status: result.status, source: result.source, simulated: result.provenance.simulated === true } });
    return result;
  }

  async function verify(actor: Actor, wcase: WatsonCase, actionId: string, actionSucceeded: boolean): Promise<VerificationStatus> {
    const def = getAction(actionId);
    if (!def || def.verification.length === 0) return 'not_run';
    // Gather the fresh evidence the predicates need.
    const facts: FactBag = {};
    const need = new Set(def.verification);
    if ([...need].some((p) => p.startsWith('teams_process') || p === 'teams_stable_10s')) {
      const e = await collectEvidence(actor, wcase, 'process_health', { processName: 'Teams' });
      facts.process = e.facts;
    }
    if ([...need].some((p) => p.startsWith('teams_cache'))) {
      const e = await collectEvidence(actor, wcase, 'teams_health');
      facts.teams = e.facts;
    }
    if ([...need].some((p) => p.startsWith('network'))) {
      const e = await collectEvidence(actor, wcase, 'network_health');
      facts.network = e.facts;
    }
    const allPass = def.verification.every((p) => (PREDICATES[p] ? PREDICATES[p](facts, actionSucceeded) : false));
    return allPass ? 'passed' : 'failed';
  }

  async function runAction(actor: Actor, wcase: WatsonCase, actionId: string, parameters: Record<string, unknown> = {}, approvalId?: string): Promise<ActionResult> {
    const requestId = rid('ac');
    const request: ActionRequest = { requestId, caseId: wcase.caseId, actorId: actor.actorId, deviceId: wcase.device?.deviceId ?? '', actionId, parameters, approvalId };
    const decision = canPerformAction(actor, request, wcase.device, wcase.canceled);
    if (!decision.allowed) {
      appendEvent({ caseId: wcase.caseId, tenantId: wcase.tenantId, type: 'action_denied', actorId: actor.actorId, actorAuthority: actor.authority, deviceId: wcase.device?.deviceId, data: { actionId, category: decision.category, reason: decision.reason } });
      return { requestId, status: 'denied', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), evidence: [], verificationStatus: 'not_run', reason: decision.category };
    }
    const def = getAction(actionId)!;
    // Pilot safety floor: only LOW-risk actions may execute in this build. Elevated/critical fail closed.
    if (def.riskTier !== 'low') {
      appendEvent({ caseId: wcase.caseId, tenantId: wcase.tenantId, type: 'action_denied', actorId: actor.actorId, actorAuthority: actor.authority, deviceId: wcase.device?.deviceId, data: { actionId, category: 'not_in_pilot', riskTier: def.riskTier } });
      return { requestId, status: 'denied', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), evidence: [], verificationStatus: 'not_run', reason: 'elevated_not_in_pilot' };
    }
    appendEvent({ caseId: wcase.caseId, tenantId: wcase.tenantId, type: 'action_executed', actorId: actor.actorId, actorAuthority: actor.authority, deviceId: wcase.device?.deviceId, data: { actionId, phase: 'started', changesDevice: def.changesDevice, approvalId: approvalId ?? null } });

    const raced = await withTimeout(port.executeAction(request), def.timeoutSeconds);
    if (raced.timedOut) {
      appendEvent({ caseId: wcase.caseId, tenantId: wcase.tenantId, type: 'action_executed', actorId: actor.actorId, actorAuthority: actor.authority, deviceId: wcase.device?.deviceId, data: { actionId, phase: 'timed_out' } });
      return { requestId, status: 'timed_out', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), evidence: [], verificationStatus: 'not_run', reason: 'timed_out' };
    }
    const base = raced.value;
    // Mandatory verification (deterministic, from fresh evidence).
    const verification = base.status === 'succeeded' ? await verify(actor, wcase, actionId, true) : 'not_run';
    const result: ActionResult = { ...base, requestId, verificationStatus: verification };
    appendEvent({ caseId: wcase.caseId, tenantId: wcase.tenantId, type: 'verification_completed', actorId: actor.actorId, actorAuthority: actor.authority, deviceId: wcase.device?.deviceId, data: { actionId, actionStatus: result.status, verificationStatus: verification } });
    return result;
  }

  return { collectEvidence, runAction };
}
