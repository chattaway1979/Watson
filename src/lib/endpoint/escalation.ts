// ============================================================
// Watson Remote IT Operator — Escalation package builder
// ------------------------------------------------------------
// A technician-ready package: complaint, device, all evidence,
// ranked hypotheses, every action attempted with outcome +
// verification, and the next recommended technician step.
// ============================================================
import type { WatsonCase, EscalationPackage, Hypothesis } from './contracts';

const TECH_STEP: Record<string, string> = {
  endpoint_unavailable: 'Confirm the device is powered on and online, then re-run remote diagnostics.',
  service_outage: 'This is a Microsoft 365 service-side issue — monitor Microsoft service health; no device change is warranted.',
  network_instability: 'Investigate the network path to Teams/M365 (Wi-Fi, VPN, proxy, DNS) for this device.',
  low_disk: 'Free additional disk space; cache clear was insufficient. Review large files / disk cleanup.',
  resource_pressure: 'Investigate sustained high memory use (startup apps, runaway process, RAM sizing).',
  pending_restart: 'Confirm and complete the pending Windows restart/update with the employee.',
  corrupt_cache: 'If cache clear did not hold, consider a Teams client reinstall.',
  process_hang: 'If restart did not hold, capture a process dump and review the Teams client version.',
  transient: 'No fault reproduced from current evidence; ask the employee to report the next occurrence time.'
};

export function nextTechnicianStep(top: Hypothesis | undefined): string {
  if (!top) return 'Review the collected evidence and contact the employee.';
  return TECH_STEP[top.id] ?? 'Review the collected evidence and continue diagnosis.';
}

export function buildEscalation(wcase: WatsonCase): EscalationPackage {
  const top = wcase.hypotheses[0];
  return {
    caseId: wcase.caseId,
    createdAt: new Date().toISOString(),
    complaint: wcase.complaint,
    employee: { actorId: wcase.actor?.actorId ?? 'unknown', tenantId: wcase.tenantId, displayName: wcase.actor?.displayName },
    device: wcase.device,
    evidence: wcase.evidence,
    hypotheses: wcase.hypotheses,
    actionsAttempted: wcase.actions.map((a) => ({ actionId: a.actionId, status: a.status, verificationStatus: a.verificationStatus, at: a.at })),
    finalState: wcase.state,
    nextRecommendedTechnicianStep: nextTechnicianStep(top),
    simulated: wcase.simulated
  };
}
