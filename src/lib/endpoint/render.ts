// ============================================================
// Watson Remote IT Operator — Employee-safe rendering
// ------------------------------------------------------------
// Produces employee-facing text. It must NEVER expose internal
// engine labels (mock, mock-executable, deterministic, fallback,
// prepared, policy engine, action IDs). When running against the
// simulator it MUST honestly disclose that it is a demonstration
// and that no real computer was changed.
// ============================================================
import type { WatsonCase, Hypothesis, EmployeeMessage, ActionResult } from './contracts';
import { getAction } from './catalog';

// Words that must never leak into employee-facing text.
const FORBIDDEN_LABELS = /\b(mock-executable|mock|deterministic fallback|deterministic|fallback|prepared|policy engine|allowlist|risk tier|approval level|actionId)\b/i;

export function assertNoInternalLabels(text: string): void {
  if (FORBIDDEN_LABELS.test(text)) {
    throw new Error(`Employee text leaked an internal label: ${text}`);
  }
}

export function containsInternalLabel(text: string): boolean {
  return FORBIDDEN_LABELS.test(text);
}

function sim(wcase: WatsonCase): string {
  return wcase.simulated
    ? ' (This is a demonstration against a test device — no real computer was changed.)'
    : '';
}

export function renderConnecting(wcase: WatsonCase): EmployeeMessage {
  return {
    text: `Thanks — let me take a look at your computer directly instead of asking you to run checks.${sim(wcase)}`,
    connectionState: 'connecting', changesDeviceNext: false, approvalRequested: false,
    verificationPassed: null, simulated: wcase.simulated, stopAvailable: true
  };
}

export function renderInspecting(wcase: WatsonCase): EmployeeMessage {
  return {
    text: `Connected to ${wcase.device?.hostname ?? 'your computer'}. I'm checking Teams, system resources, recent errors and your network now.`,
    connectionState: 'inspecting', changesDeviceNext: false, approvalRequested: false,
    verificationPassed: null, simulated: wcase.simulated, stopAvailable: true
  };
}

export function renderDiagnosis(wcase: WatsonCase, top: Hypothesis): EmployeeMessage {
  return {
    text: `Here's what I found: ${top.label.toLowerCase()}. ${top.rationale}`,
    connectionState: 'inspecting', changesDeviceNext: Boolean(top.recommendedActionId),
    approvalRequested: false, verificationPassed: null, simulated: wcase.simulated, stopAvailable: true
  };
}

export function renderApprovalRequest(wcase: WatsonCase, actionId: string): EmployeeMessage {
  const def = getAction(actionId);
  const name = def?.displayName ?? 'a quick fix';
  return {
    text: `I'd like to ${name.toLowerCase()} for you. This will briefly affect the app on your computer. Shall I go ahead? You can stop at any time.`,
    connectionState: 'working', changesDeviceNext: true, approvalRequested: true,
    verificationPassed: null, simulated: wcase.simulated, stopAvailable: true
  };
}

export function renderResolved(wcase: WatsonCase, actionId: string, _result: ActionResult): EmployeeMessage {
  const def = getAction(actionId);
  const name = def?.displayName ?? 'the fix';
  return {
    text: `Done — I ran "${name}" and confirmed Teams is now open and stable. If it freezes again, just tell me.${sim(wcase)}`,
    connectionState: 'done', changesDeviceNext: false, approvalRequested: false,
    verificationPassed: true, simulated: wcase.simulated, stopAvailable: false
  };
}

export function renderUnresolvedEscalation(wcase: WatsonCase, top: Hypothesis, techStep: string): EmployeeMessage {
  return {
    text: `I couldn't safely resolve this from here — it looks like ${top.label.toLowerCase()}. I've handed everything I found to the IT team so they can take it from here (${techStep}). You don't need to repeat anything.${sim(wcase)}`,
    connectionState: 'done', changesDeviceNext: false, approvalRequested: false,
    verificationPassed: false, simulated: wcase.simulated, stopAvailable: false
  };
}

export function renderStopped(wcase: WatsonCase): EmployeeMessage {
  return {
    text: `Stopped. I haven't made any further changes to your computer.${sim(wcase)}`,
    connectionState: 'done', changesDeviceNext: false, approvalRequested: false,
    verificationPassed: null, simulated: wcase.simulated, stopAvailable: false
  };
}
