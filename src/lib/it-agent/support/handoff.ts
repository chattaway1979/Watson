// ============================================================
// Watson — 012 : Technician handoff record (Part E)
// ------------------------------------------------------------
// When Watson cannot resolve something it must hand over a record a technician
// can act on WITHOUT re-interviewing the employee. A handoff that omits what
// was already ruled out is worse than no handoff: it wastes the technician's
// time and makes the employee repeat themselves.
//
// The record therefore captures negative findings as first-class content —
// what was tried, what did NOT work, and what remains unknown.
//
// Pure module. Redaction is applied here so no raw identifier reaches a ticket.
// ============================================================
import type { CauseClass } from './causes';

export interface HandoffRecord {
  readonly caseShortId: string;
  readonly employeeReportedSymptom: string;
  readonly affectedWorkflow: string;
  readonly businessImpact: 'none' | 'individual' | 'team' | 'company';
  readonly priority: 'low' | 'normal' | 'high' | 'urgent';

  readonly device: { readonly label: string; readonly os: string; readonly managed: boolean };
  readonly applicationVersion: string | null;
  readonly applicationEdition: string | null;

  // The discriminators a technician would otherwise have to re-establish.
  readonly fileSpecificVsApplicationWide: 'file_specific' | 'application_wide' | 'undetermined';
  readonly knownGoodComparison: 'known_good_works' | 'known_good_also_fails' | 'not_tested';
  readonly reproducesOnOtherDevice: boolean | null;
  readonly localVsSynced: 'local_works' | 'both_fail' | 'not_tested';

  readonly syncState: string | null;
  readonly lockState: string | null;
  readonly unsavedWorkPresent: boolean | null;

  readonly suspectedCause: CauseClass;
  readonly confidence: 'high' | 'moderate' | 'low';
  // Explicitly what was ruled OUT, and on what basis.
  readonly ruledOut: ReadonlyArray<{ readonly cause: CauseClass; readonly becauseOf: string }>;
  readonly actionsAttempted: ReadonlyArray<{ readonly action: string; readonly outcome: string }>;
  readonly stillUnknown: readonly string[];
  readonly escalationReason: string;
  readonly suggestedNextSteps: readonly string[];
  readonly routingQueue: string;
}

// Values that must never reach a ticket in raw form.
const SENSITIVE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[employee]'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id]'],
  [/\b(eyJ[A-Za-z0-9_-]{10,})\b/g, '[token]'],
  [/\\\\[^\s]+\\[^\s]+/g, '[unc-path]']
];

// Redact free text before it leaves Watson. Applied to every string field, so a
// stray address pasted by an employee into a symptom description cannot end up
// in a ticket body.
export function redactForHandoff(text: string): string {
  let out = typeof text === 'string' ? text : '';
  for (const [re, replacement] of SENSITIVE_PATTERNS) out = out.replace(re, replacement);
  return out;
}

export interface HandoffCompleteness {
  complete: boolean;
  missing: string[];
}

// A handoff is only useful if the technician can act on it. These are the
// fields whose absence would force a re-interview.
export function assessHandoffCompleteness(h: Partial<HandoffRecord>): HandoffCompleteness {
  const missing: string[] = [];
  if (!h.employeeReportedSymptom) missing.push('employeeReportedSymptom');
  if (!h.affectedWorkflow) missing.push('affectedWorkflow');
  if (!h.businessImpact) missing.push('businessImpact');
  if (!h.device) missing.push('device');
  if (!h.suspectedCause) missing.push('suspectedCause');
  if (!h.escalationReason) missing.push('escalationReason');
  if (!h.routingQueue) missing.push('routingQueue');
  if (!h.actionsAttempted || h.actionsAttempted.length === 0) missing.push('actionsAttempted');
  // Negative findings are required, not optional: "we ruled nothing out" is a
  // legitimate value, but silence about it is not.
  if (!h.ruledOut) missing.push('ruledOut');
  if (!h.stillUnknown) missing.push('stillUnknown');
  return { complete: missing.length === 0, missing };
}

export function buildHandoff(input: HandoffRecord): HandoffRecord {
  return {
    ...input,
    employeeReportedSymptom: redactForHandoff(input.employeeReportedSymptom),
    affectedWorkflow: redactForHandoff(input.affectedWorkflow),
    escalationReason: redactForHandoff(input.escalationReason),
    suggestedNextSteps: input.suggestedNextSteps.map(redactForHandoff),
    stillUnknown: input.stillUnknown.map(redactForHandoff),
    actionsAttempted: input.actionsAttempted.map((a) => ({
      action: redactForHandoff(a.action),
      outcome: redactForHandoff(a.outcome)
    }))
  };
}

// Plain-text rendering for a ticket body. Deterministic ordering so diffs and
// tests are stable.
export function renderHandoff(h: HandoffRecord): string {
  const lines: string[] = [];
  lines.push(`Case ${h.caseShortId} — escalated by Watson`);
  lines.push(`Priority: ${h.priority}   Business impact: ${h.businessImpact}   Queue: ${h.routingQueue}`);
  lines.push('');
  lines.push(`Reported: ${h.employeeReportedSymptom}`);
  lines.push(`Blocked workflow: ${h.affectedWorkflow}`);
  lines.push(`Device: ${h.device.label} (${h.device.os}${h.device.managed ? ', managed' : ''})`);
  if (h.applicationVersion) lines.push(`Application: ${h.applicationVersion}${h.applicationEdition ? ` ${h.applicationEdition}` : ''}`);
  lines.push('');
  lines.push('What Watson established:');
  lines.push(`  Scope: ${h.fileSpecificVsApplicationWide}`);
  lines.push(`  Known-good comparison: ${h.knownGoodComparison}`);
  lines.push(`  Local vs synced: ${h.localVsSynced}`);
  if (h.reproducesOnOtherDevice !== null) lines.push(`  Reproduces on another device: ${h.reproducesOnOtherDevice ? 'yes' : 'no'}`);
  if (h.syncState) lines.push(`  Sync state: ${h.syncState}`);
  if (h.lockState) lines.push(`  Lock state: ${h.lockState}`);
  if (h.unsavedWorkPresent !== null) lines.push(`  Unsaved work present: ${h.unsavedWorkPresent ? 'YES — preserve before any action' : 'no'}`);
  lines.push('');
  lines.push(`Suspected cause: ${h.suspectedCause} (confidence: ${h.confidence})`);
  if (h.ruledOut.length > 0) {
    lines.push('Ruled out:');
    for (const r of h.ruledOut) lines.push(`  - ${r.cause} — ${r.becauseOf}`);
  }
  lines.push('Actions attempted:');
  if (h.actionsAttempted.length === 0) lines.push('  - none');
  for (const a of h.actionsAttempted) lines.push(`  - ${a.action}: ${a.outcome}`);
  if (h.stillUnknown.length > 0) {
    lines.push('Still unknown:');
    for (const u of h.stillUnknown) lines.push(`  - ${u}`);
  }
  lines.push('');
  lines.push(`Why escalated: ${h.escalationReason}`);
  if (h.suggestedNextSteps.length > 0) {
    lines.push('Suggested next steps:');
    for (const s of h.suggestedNextSteps) lines.push(`  - ${s}`);
  }
  return lines.join('\n');
}
