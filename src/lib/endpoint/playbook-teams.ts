// ============================================================
// Watson Remote IT Operator — Teams-freezing Diagnostic Playbook
// ------------------------------------------------------------
// Deterministic. Declares the evidence to gather automatically and
// ranks likely causes FROM the gathered evidence, so the same
// complaint produces different diagnoses on different endpoints.
// Cause labels and rationale are employee-safe (no engine labels).
// ============================================================
import type { EvidenceResult, Hypothesis } from './contracts';

export const TEAMS_PLAYBOOK_ID = 'teams_freezing';

// Evidence gathered automatically BEFORE any question is asked.
export const TEAMS_EVIDENCE_PLAN: string[] = [
  'device_health',
  'process_health',
  'teams_health',
  'event_logs',
  'network_health',
  'm365_service_health'
];

export interface MergedFacts {
  online: boolean;
  endpointReachable: boolean;
  memoryPct: number | null;
  diskFreeGb: number | null;
  pendingRestart: boolean | null;
  processState: string | null;
  recentCrashes: number | null;
  cacheCorrupt: boolean | null;
  networkReachable: boolean | null;
  m365Teams: string | null;
}

export function mergeTeamsFacts(results: EvidenceResult[]): MergedFacts {
  const pick = (predicate: (f: Record<string, unknown>) => boolean) => {
    const r = results.find((x) => x.status === 'succeeded' && predicate(x.facts));
    return r?.facts;
  };
  const anyUnavailable = results.some((r) => r.status === 'unavailable' || (r.facts && (r.facts as { online?: boolean }).online === false));
  const dev = pick((f) => 'memoryPct' in f || 'diskFreeGb' in f);
  const proc = pick((f) => 'processName' in f && 'state' in f);
  const teams = pick((f) => 'recentCrashes' in f);
  const net = pick((f) => 'reachable' in f);
  const m365 = pick((f) => 'teams' in f && 'overall' in f);
  return {
    online: !anyUnavailable,
    endpointReachable: !anyUnavailable,
    memoryPct: (dev?.memoryPct as number) ?? null,
    diskFreeGb: (dev?.diskFreeGb as number) ?? null,
    pendingRestart: (dev?.pendingRestart as boolean) ?? null,
    processState: (proc?.state as string) ?? null,
    recentCrashes: (teams?.recentCrashes as number) ?? null,
    cacheCorrupt: (teams?.cacheCorrupt as boolean) ?? null,
    networkReachable: (net?.reachable as boolean) ?? null,
    m365Teams: (m365?.teams as string) ?? null
  };
}

// Ranked, evidence-grounded hypotheses. Higher score = more likely.
// The top hypothesis' recommendedActionId (if any) drives remediation;
// hypotheses with no low-risk device action lead to escalation.
export function rankTeamsHypotheses(f: MergedFacts): Hypothesis[] {
  const h: Hypothesis[] = [];
  const add = (id: string, label: string, score: number, rationale: string, facts: string[], action?: string) =>
    h.push({ id, label, score, rationale, supportingFacts: facts, recommendedActionId: action });

  if (!f.endpointReachable || f.online === false) {
    add('endpoint_unavailable', 'The computer is currently offline', 0.98,
      'The device is not reachable for inspection right now.', ['device offline'], undefined);
  }
  if (f.m365Teams && f.m365Teams !== 'healthy') {
    add('service_outage', 'A Microsoft 365 Teams service issue', 0.9,
      `Microsoft reports Teams service status: ${f.m365Teams}.`, [`m365 teams=${f.m365Teams}`], undefined);
  }
  if (f.networkReachable === false) {
    add('network_instability', 'A network connectivity problem', 0.88,
      'The computer cannot currently reach the Teams service endpoints.', ['network unreachable'], undefined);
  }
  if (typeof f.diskFreeGb === 'number' && f.diskFreeGb < 5) {
    add('low_disk', 'Very low free disk space', 0.85,
      `Only ${f.diskFreeGb} GB free; Teams needs working space to run smoothly.`, [`diskFreeGb=${f.diskFreeGb}`], 'clear_teams_cache');
  }
  if (typeof f.memoryPct === 'number' && f.memoryPct >= 90) {
    add('resource_pressure', 'High memory pressure on the computer', 0.8,
      `Memory use is ${f.memoryPct}%, which can make Teams freeze.`, [`memoryPct=${f.memoryPct}`], 'restart_teams');
  }
  if (f.pendingRestart === true) {
    add('pending_restart', 'A pending Windows restart or update', 0.78,
      'A restart is pending; Teams can misbehave until the computer is restarted.', ['pendingRestart=true'], undefined);
  }
  if (f.cacheCorrupt === true || (typeof f.recentCrashes === 'number' && f.recentCrashes > 0)) {
    add('corrupt_cache', 'A corrupted Teams cache', 0.8,
      `Teams shows ${f.recentCrashes ?? 'recent'} recent crash signatures consistent with a bad cache.`, [`recentCrashes=${f.recentCrashes}`, `cacheCorrupt=${f.cacheCorrupt}`], 'clear_teams_cache');
  }
  if (f.processState === 'not_responding' || f.processState === 'not_running') {
    add('process_hang', 'The Teams application is hung', 0.72,
      `The Teams process is ${f.processState}.`, [`processState=${f.processState}`], 'restart_teams');
  }
  if (h.length === 0) {
    add('transient', 'No clear fault detected from current evidence', 0.3,
      'Teams and the device look healthy right now; the issue may be intermittent.', ['no fault signature'], undefined);
  }
  return h.sort((a, b) => b.score - a.score);
}
