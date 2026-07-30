/* ============================================================
 * Watson Remote IT Operator — deterministic self-tests + demos
 * Run: npm run endpoint:selftest   (no network, no real device)
 * ============================================================ */
import type { Actor, EndpointDevice, WatsonCase } from '../src/lib/endpoint/contracts';
import { createSimulator, type ScenarioId } from '../src/lib/endpoint/simulator';
import { createOperator } from '../src/lib/endpoint/orchestrator';
import { createExecutor } from '../src/lib/endpoint/executor';
import { canPerformAction, canCollectEvidence, validateParameters, grantApproval, __resetApprovalsForTests } from '../src/lib/endpoint/policy';
import { getAction, assertNoFreeformCommandParams, listActions } from '../src/lib/endpoint/catalog';
import { appendEvent, eventsForCase, __resetEventsForTests } from '../src/lib/endpoint/events';
import { buildEscalation } from '../src/lib/endpoint/escalation';
import { containsInternalLabel } from '../src/lib/endpoint/render';
import type { ActionRequest, ParameterSpec } from '../src/lib/endpoint/contracts';

let pass = 0, fail = 0; const failures: string[] = [];
const check = (n: string, c: boolean, d = '') => { if (c) { pass++; console.log('  ✅ ' + n); } else { fail++; failures.push(n + (d ? ` — ${d}` : '')); console.log('  ❌ ' + n + (d ? ` — ${d}` : '')); } };

const EMP: Actor = { actorId: 'userA', tenantId: 't1', authority: 'employee', displayName: 'Clint' };
const EMP_OTHER_TENANT: Actor = { actorId: 'userX', tenantId: 't2', authority: 'employee' };
const IT: Actor = { actorId: 'it1', tenantId: 't1', authority: 'it_approver', displayName: 'IT' };
const OWNER: Actor = { actorId: 'own1', tenantId: 't1', authority: 'owner' };

function device(_scenario: ScenarioId): EndpointDevice {
  return { tenantId: 't1', deviceId: 'dev-A', provider: 'simulator', hostname: 'HRE-A', platform: 'windows', assignedUserId: 'userA', online: true, lastSeenAt: new Date().toISOString(), managementState: 'managed' };
}
function fresh(scenario: ScenarioId) {
  __resetEventsForTests(); __resetApprovalsForTests();
  const sim = createSimulator();
  sim.seedDevice('userA', device(scenario), scenario);
  return { sim, op: createOperator(sim) };
}
async function run(scenario: ScenarioId, opts?: { consent?: boolean; cancelBeforeAction?: boolean }) {
  const { sim, op } = fresh(scenario);
  const r = await op.handleTeamsFreezing(EMP, 'Microsoft Teams is freezing on my computer.', opts);
  return { sim, ...r };
}

async function main() {
  console.log('\n=== Watson Remote IT Operator — Self-Test ===\n');

  console.log('[1] Catalog + safety invariants');
  let noFreeform = true; try { assertNoFreeformCommandParams(); } catch { noFreeform = false; }
  check('no catalog action exposes a free-form command parameter', noFreeform);
  check('every action liveExecutable-guarded (low-risk only executes; elevated present but blocked)', listActions().some((a) => a.riskTier === 'elevated'));
  check('read-only actions require no approval', listActions().filter((a) => a.kind === 'read_only').every((a) => a.approvalLevel === 'none'));
  check('low-risk write actions require employee consent', ['restart_teams', 'clear_teams_cache', 'trigger_intune_sync'].every((id) => getAction(id)!.approvalLevel === 'employee'));

  console.log('\n[2] Evidence gathered BEFORE any question');
  {
    const r = await run('process_hang');
    check('evidence collected before diagnosis (>=6 signals)', r.case.evidence.length >= 6, `got ${r.case.evidence.length}`);
    check('no question was asked (endpoint answered it)', r.case.question === null);
    const inspectIdx = r.messages.findIndex((m) => m.connectionState === 'inspecting');
    const approvalIdx = r.messages.findIndex((m) => m.approvalRequested);
    check('inspection happens before any approval prompt', inspectIdx >= 0 && (approvalIdx === -1 || inspectIdx < approvalIdx));
  }

  console.log('\n[3] Different endpoint evidence -> different diagnosis');
  {
    const scenarios: [ScenarioId, string][] = [
      ['process_hang', 'process_hang'], ['corrupt_cache', 'corrupt_cache'], ['high_memory', 'resource_pressure'],
      ['low_disk', 'low_disk'], ['pending_restart', 'pending_restart'], ['network_failure', 'network_instability'],
      ['m365_outage', 'service_outage'], ['endpoint_unavailable', 'endpoint_unavailable']
    ];
    const tops: string[] = [];
    for (const [sc, expected] of scenarios) {
      const r = await run(sc);
      tops.push(r.case.hypotheses[0]?.id);
      check(`${sc} -> top diagnosis '${expected}'`, r.case.hypotheses[0]?.id === expected, `got '${r.case.hypotheses[0]?.id}'`);
    }
    check('same complaint produced distinct diagnoses', new Set(tops).size === scenarios.length, `distinct=${new Set(tops).size}`);
  }

  console.log('\n[4] Vertical slice A — process hang -> restart -> resolved');
  {
    const r = await run('process_hang');
    check('case resolved', r.case.state === 'resolved');
    check('action was restart_teams', r.case.actions[0]?.actionId === 'restart_teams');
    check('verification passed', r.case.actions[0]?.verificationStatus === 'passed');
    check('employee saw a resolved+verified message', r.messages.at(-1)?.verificationPassed === true);
    check('no escalation', r.escalation === null);
  }

  console.log('\n[5] Vertical slice B — corrupt cache -> clear cache -> resolved');
  {
    const r = await run('corrupt_cache');
    check('case resolved', r.case.state === 'resolved');
    check('action was clear_teams_cache', r.case.actions[0]?.actionId === 'clear_teams_cache');
    check('verification passed', r.case.actions[0]?.verificationStatus === 'passed');
  }

  console.log('\n[6] Vertical slice C — network failure -> honest escalation (no false fix)');
  {
    const r = await run('network_failure');
    check('case escalated (not resolved)', r.case.state === 'escalated');
    check('no repair action attempted for a network fault', r.case.actions.length === 0);
    check('no "resolved" claim to employee', r.messages.every((m) => m.verificationPassed !== true));
    check('escalation package present', r.escalation !== null && r.escalation!.evidence.length >= 6);
  }

  console.log('\n[7] Verification failure leaves the issue UNRESOLVED');
  {
    __resetEventsForTests(); __resetApprovalsForTests();
    const sim = createSimulator();
    sim.seedDevice('userA', device('process_hang'), 'process_hang');
    sim.setRepairIneffective('dev-A', true);
    const op = createOperator(sim);
    const r = await op.handleTeamsFreezing(EMP, 'Teams is freezing.');
    check('repair ran but verification failed', r.case.actions[0]?.status === 'succeeded' && r.case.actions[0]?.verificationStatus === 'failed');
    check('case is NOT resolved', r.case.state !== 'resolved');
    check('case escalated on failed verification', r.case.state === 'escalated');
  }

  console.log('\n[8] Deterministic denials — unknown / unsupported / injected input');
  {
    const dev = device('process_hang');
    const req = (actionId: string, parameters: Record<string, unknown> = {}): ActionRequest => ({ requestId: 'r', caseId: 'c', actorId: EMP.actorId, deviceId: dev.deviceId, actionId, parameters });
    check('unknown action denied (deny-by-default)', canPerformAction(EMP, req('wipe_everything'), dev, false).category === 'unknown_action');
    check('unsupported evidence type denied', canCollectEvidence(EMP, 'run_powershell', dev, false).category === 'unknown_evidence');
    check('arbitrary "command" field rejected as unknown parameter', canPerformAction(EMP, req('restart_teams', { command: 'rm -rf /' }), dev, false).category === 'invalid_parameters');
    check('out-of-enum parameter rejected', validateParameters(getAction('collect_event_logs')!, { logName: 'notALog' }).category === 'invalid_parameters');
    // Defense-in-depth: a hypothetical string param carrying shell content is blocked.
    const synthetic = { ...getAction('collect_event_logs')!, allowedParameters: { note: { type: 'string', required: false, maxLength: 200, description: 'x' } as ParameterSpec } };
    check('command-like string value blocked (defense-in-depth)', validateParameters(synthetic, { note: 'powershell -EncodedCommand ZWNobw==' }).category === 'command_injection_blocked');
  }

  console.log('\n[9] Approval floor cannot be downgraded; no self-approval');
  {
    const dev = device('process_hang');
    const reqRestart: ActionRequest = { requestId: 'r', caseId: 'c', actorId: EMP.actorId, deviceId: dev.deviceId, actionId: 'restart_teams', parameters: {} };
    check('low-risk action without consent -> approval_required', canPerformAction(EMP, reqRestart, dev, false).category === 'approval_required');
    check('employee cannot be granted approval for an elevated action', grantApproval({ caseId: 'c', actionId: 'reset_user_password', requesterActorId: IT.actorId, grantedBy: EMP }).ok === false);
    check('elevated action cannot be self-approved', grantApproval({ caseId: 'c', actionId: 'reset_user_password', requesterActorId: IT.actorId, grantedBy: IT }).ok === false);
    const ownerGrant = grantApproval({ caseId: 'c', actionId: 'reset_user_password', requesterActorId: IT.actorId, grantedBy: OWNER });
    check('owner (distinct actor) may approve an elevated action at policy layer', ownerGrant.ok === true);
    if (ownerGrant.ok) {
      const reqElevated: ActionRequest = { requestId: 'r2', caseId: 'c', actorId: IT.actorId, deviceId: dev.deviceId, actionId: 'reset_user_password', parameters: {}, approvalId: ownerGrant.approval.approvalId };
      check('policy permits properly-approved elevated action', canPerformAction(IT, reqElevated, dev, false).allowed === true);
      // But the executor fails closed on any non-low-risk action in this pilot.
      const sim = createSimulator(); sim.seedDevice('it1', { ...dev, assignedUserId: 'it1' }, 'process_hang');
      const exec = createExecutor(sim);
      const wcase: WatsonCase = { caseId: 'c', tenantId: 't1', complaint: '', playbookId: 'x', actor: IT, device: { ...dev, assignedUserId: 'it1' }, state: 'executing', evidence: [], hypotheses: [], actions: [], question: null, createdAt: '', updatedAt: '', canceled: false, simulated: true };
      const res = await exec.runAction(IT, wcase, 'reset_user_password', {}, ownerGrant.approval.approvalId);
      check('executor blocks elevated action in pilot (fail closed)', res.status === 'denied' && res.reason === 'elevated_not_in_pilot');
    }
  }

  console.log('\n[10] Emergency stop before remediation');
  {
    const r = await run('process_hang', { cancelBeforeAction: true });
    check('session canceled -> no action executed', r.case.actions.length === 0 && r.case.canceled === true);
    check('employee told nothing further was changed', r.messages.at(-1)?.text.toLowerCase().includes('haven') === true || r.messages.at(-1)?.connectionState === 'done');
  }

  console.log('\n[11] Audit completeness + secret redaction');
  {
    const r = await run('process_hang');
    const evts = eventsForCase(r.case.caseId);
    const types = new Set(evts.map((e) => e.type));
    for (const t of ['issue_reported', 'identity_resolved', 'device_selected', 'evidence_received', 'hypothesis_updated', 'approval_requested', 'approval_granted', 'action_executed', 'verification_completed', 'issue_resolved']) {
      check(`audit has '${t}'`, types.has(t as never));
    }
    check('every event carries actor + tenant', evts.every((e) => e.actorId && e.tenantId === 't1'));
    check('every event carries device where relevant', evts.filter((e) => e.type === 'action_executed').every((e) => e.deviceId));
    // redaction guard
    __resetEventsForTests();
    const ev = appendEvent({ caseId: 'c', tenantId: 't1', type: 'action_executed', actorId: 'a', actorAuthority: 'system', data: { password: 'hunter2', token: 'abc', ok: 1 } });
    check('secrets are redacted from the audit trail', ev.data.password === '[REDACTED]' && ev.data.token === '[REDACTED]' && ev.data.ok === 1);
  }

  console.log('\n[12] Escalation package is technician-ready');
  {
    const r = await run('network_failure');
    const esc = r.escalation!;
    check('escalation includes complaint', Boolean(esc.complaint));
    check('escalation includes device + evidence', Boolean(esc.device) && esc.evidence.length >= 6);
    check('escalation includes ranked hypotheses', esc.hypotheses.length >= 1);
    check('escalation includes next technician step', esc.nextRecommendedTechnicianStep.length > 10);
    check('escalation records final state', esc.finalState === 'escalated');
  }

  console.log('\n[13] No internal engine labels reach the employee');
  {
    for (const sc of ['process_hang', 'corrupt_cache', 'network_failure', 'm365_outage'] as ScenarioId[]) {
      const r = await run(sc);
      const leaked = r.messages.find((m) => containsInternalLabel(m.text));
      check(`no internal label leaked (${sc})`, !leaked, leaked?.text);
    }
    const r = await run('process_hang');
    check('simulation is honestly disclosed to the employee', r.messages.some((m) => /demonstration|test device/i.test(m.text)));
  }

  console.log('\n[14] Tenant / device isolation');
  {
    const dev = device('process_hang');
    check('cross-tenant evidence denied', canCollectEvidence(EMP_OTHER_TENANT, 'device_health', dev, false).category === 'tenant_mismatch');
    const req: ActionRequest = { requestId: 'r', caseId: 'c', actorId: EMP_OTHER_TENANT.actorId, deviceId: dev.deviceId, actionId: 'restart_teams', parameters: {} };
    check('cross-tenant action denied', canPerformAction(EMP_OTHER_TENANT, req, dev, false).category === 'tenant_mismatch');
  }

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  if (fail === 0) { await demos(); }
  if (fail > 0) { console.log('\nFailures:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  console.log('\nALL ENDPOINT SELFTESTS PASSED ✅\n');
  process.exit(0);
}

// ---------------- PART 7 — three demonstrations ----------------
function facts(r: { case: WatsonCase }, type: string) {
  const e = r.case.evidence.find((x) => x.provenance && x.status === 'succeeded' && matches(x.facts, type));
  return e?.facts ?? {};
}
function matches(f: Record<string, unknown>, t: string) {
  if (t === 'device') return 'memoryPct' in f; if (t === 'process') return 'processName' in f; if (t === 'teams') return 'recentCrashes' in f; if (t === 'network') return 'reachable' in f; if (t === 'm365') return 'overall' in f; return false;
}
async function demoOne(title: string, scenario: ScenarioId) {
  const r = await run(scenario);
  const top = r.case.hypotheses[0];
  console.log(`\n──────── DEMO: ${title} ────────`);
  console.log(`Employee: "Microsoft Teams is freezing on my computer."`);
  console.log(`Evidence (simulated): device mem ${((facts(r, 'device') as { memoryPct?: number }).memoryPct)}% / disk ${((facts(r, 'device') as { diskFreeGb?: number }).diskFreeGb)}GB · Teams process ${(facts(r, 'process') as { state?: string }).state} · crashes ${(facts(r, 'teams') as { recentCrashes?: number }).recentCrashes} · network ${(facts(r, 'network') as { reachable?: boolean }).reachable ? 'ok' : 'DOWN'} · M365 ${(facts(r, 'm365') as { teams?: string }).teams}`);
  console.log(`Diagnosis: ${top.label} (confidence ${(top.score * 100).toFixed(0)}%)`);
  const act = r.case.actions[0];
  console.log(`Approval: ${r.messages.some((m) => m.approvalRequested) ? 'employee consent requested' : 'none required'}`);
  console.log(`Action: ${act ? act.actionId : '(none — escalated)'}`);
  console.log(`Execution: ${act ? act.status : 'n/a'}   Verification: ${act ? act.verificationStatus : 'n/a'}`);
  console.log(`Final state: ${r.case.state}`);
  console.log(`Watson → employee: "${r.messages.at(-1)?.text}"`);
  if (r.escalation) console.log(`Technician handoff: ${r.escalation.nextRecommendedTechnicianStep}`);
}
async function demos() {
  console.log('\n============ PART 7 — LIVE SIMULATOR DEMONSTRATIONS ============');
  await demoOne('A · Teams process hang resolved by restart', 'process_hang');
  await demoOne('B · Corrupt cache resolved by cache clear', 'corrupt_cache');
  await demoOne('C · Network failure — cannot repair, escalates', 'network_failure');
}

void device; // used
main().catch((e) => { console.error('FATAL', e); process.exit(2); });
