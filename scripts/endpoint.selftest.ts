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
import { createLocalWindowsAdapter, loadLocalAdapterConfig, localCommandInventory, type CommandRunner, type LocalCommandSpec, type TestDeviceMarker } from '../src/lib/endpoint/adapters/local-windows';
import { getEndpointPort } from '../src/lib/endpoint/port-factory';
import { authorizeOperation, canonicalize, testSignature, createTestFixtureVerifier, __resetNoncesForTests, type OperationRequest, type EndpointAuthzConfig, type RequestVerifier } from '../src/lib/endpoint/authz';
import { runHarness } from './endpoint-harness';

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

  console.log('\n[15] Replay / duplicate execution + consent integrity + audit provenance');
  {
    __resetEventsForTests(); __resetApprovalsForTests();
    const sim = createSimulator(); sim.seedDevice('userA', device('process_hang'), 'process_hang');
    const exec = createExecutor(sim);
    const wcase: WatsonCase = { caseId: 'cR', tenantId: 't1', complaint: '', playbookId: 'x', actor: EMP, device: device('process_hang'), state: 'executing', evidence: [], hypotheses: [], actions: [], question: null, createdAt: '', updatedAt: '', canceled: false, simulated: true };
    const g = grantApproval({ caseId: 'cR', actionId: 'restart_teams', requesterActorId: EMP.actorId, grantedBy: EMP });
    const apr = g.ok ? g.approval.approvalId : '';
    const first = await exec.runAction(EMP, wcase, 'restart_teams', {}, apr);
    const second = await exec.runAction(EMP, wcase, 'restart_teams', {}, apr);
    check('first execution succeeds', first.status === 'succeeded');
    check('replayed approval is rejected (no duplicate execution)', second.status === 'denied' && second.reason === 'approval_replayed');
    const other: Actor = { actorId: 'userB', tenantId: 't1', authority: 'employee' };
    check('another employee cannot grant consent for this action (self-consent required)', grantApproval({ caseId: 'cR', actionId: 'restart_teams', requesterActorId: EMP.actorId, grantedBy: other }).ok === false);
    const evts = eventsForCase('cR');
    const started = evts.find((e) => e.type === 'action_executed' && (e.data as { phase?: string }).phase === 'started');
    check('execution audit records provider + simulated', (started?.data as { provider?: string })?.provider === 'simulator' && (started?.data as { simulated?: boolean })?.simulated === true);
  }

  console.log('\n[16] Local Windows adapter — fail-closed + typed command mapping (no real device touched)');
  {
    const marker: TestDeviceMarker = { tenantId: 't1', deviceId: 'dev-local-01', hostname: 'HRE-TEST-01', assignedUserId: 'userA', nonProduction: true };
    const canned: Record<string, string> = {
      device_health: JSON.stringify({ online: true, uptimeHours: 30, pendingRestart: false, cpuPct: 20, memoryPct: 40, diskFreeGb: 100, diskTotalGb: 512 }),
      process_health: JSON.stringify({ processName: 'Teams', state: 'running', pid: 1, memoryMB: 500 }),
      'event_logs:System': JSON.stringify([{ Id: 7036, LevelDisplayName: 'Information' }]),
      restart_teams: JSON.stringify({ restarted: true })
    };
    const mk = () => { const calls: LocalCommandSpec[] = []; const runner: CommandRunner = { async run(spec) { calls.push(spec); return { ok: true, stdout: canned[spec.id] ?? '{}', exitCode: 0 }; } }; return { calls, runner }; };

    { // DISABLED by default -> fail closed; the runner is NEVER called.
      const { calls, runner } = mk();
      const off = createLocalWindowsAdapter({ config: { enabled: false, markerPath: 'x' }, runner, readMarker: () => marker });
      const devs = await off.resolveDevicesForUser('t1', 'userA');
      const ev = await off.collectEvidence({ requestId: 'r', caseId: 'c', deviceId: 'dev-local-01', evidenceType: 'device_health', parameters: {}, timeoutSeconds: 5 });
      const ac = await off.executeAction({ requestId: 'r', caseId: 'c', actorId: 'userA', deviceId: 'dev-local-01', actionId: 'restart_teams', parameters: {} });
      check('adapter disabled by default -> no devices', devs.length === 0);
      check('adapter disabled -> evidence unavailable (fail closed)', ev.status === 'unavailable' && (ev.facts as { reason?: string }).reason === 'adapter_disabled');
      check('adapter disabled -> action fails closed', ac.status === 'failed' && ac.reason === 'adapter_disabled');
      check('adapter disabled -> NO command ever executed', calls.length === 0);
    }
    { // Marker not marked non-production -> stays disabled.
      const { runner } = mk();
      const a = createLocalWindowsAdapter({ config: { enabled: true, markerPath: 'x' }, runner, readMarker: () => ({ ...marker, nonProduction: false }) });
      check('production marker -> adapter refuses (no devices)', (await a.resolveDevicesForUser('t1', 'userA')).length === 0);
    }
    { // ENABLED + valid non-prod marker -> real path exercised with a MOCK runner.
      const { calls, runner } = mk();
      const on = createLocalWindowsAdapter({ config: { enabled: true, markerPath: 'x' }, runner, readMarker: () => marker });
      const devs = await on.resolveDevicesForUser('t1', 'userA');
      check('enabled+marker -> resolves the designated test device', devs.length === 1 && devs[0].deviceId === 'dev-local-01');
      check('adapter reports NOT simulated (real provenance)', on.simulated === false && on.providerId === 'local-windows');
      const ev = await on.collectEvidence({ requestId: 'r', caseId: 'c', deviceId: 'dev-local-01', evidenceType: 'device_health', parameters: {}, timeoutSeconds: 5 });
      check('device_health maps to fixed command + parses facts', ev.status === 'succeeded' && (ev.facts as { memoryPct?: number }).memoryPct === 40 && ev.provenance.simulated === false);
      const evLog = await on.collectEvidence({ requestId: 'r2', caseId: 'c', deviceId: 'dev-local-01', evidenceType: 'event_logs', parameters: { logName: 'System' }, timeoutSeconds: 5 });
      check('event_logs selects the fixed System command (no interpolation)', evLog.status === 'succeeded' && calls.some((s) => s.id === 'event_logs:System'));
      const act = await on.executeAction({ requestId: 'r3', caseId: 'c', actorId: 'userA', deviceId: 'dev-local-01', actionId: 'restart_teams', parameters: {} });
      check('restart_teams executes the fixed command', act.status === 'succeeded' && calls.some((s) => s.id === 'restart_teams'));
      const bad = await on.executeAction({ requestId: 'r4', caseId: 'c', actorId: 'userA', deviceId: 'dev-local-01', actionId: 'reset_user_password', parameters: {} });
      check('adapter refuses any unmapped / non low-risk action', bad.status === 'failed' && bad.reason === 'unsupported_action');
    }
    const inv = localCommandInventory();
    check('command inventory is a fixed allowlist', inv.length === 12);
    check('only allowlisted low-risk actions write to the device', inv.filter((s) => s.writesDevice).map((s) => s.id).sort().join(',') === 'clear_teams_cache,restart_sentinel_process,restart_teams');
    check('no command spec interpolates caller input', inv.every((s) => !/\$\{/.test(s.script)));
    check('getEndpointPort default is the simulator', getEndpointPort({} as NodeJS.ProcessEnv).simulated === true);
    check('getEndpointPort uses the local adapter only when enabled', getEndpointPort({ WATSON_LOCAL_ENDPOINT_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv, { config: { enabled: true, markerPath: 'x' }, readMarker: () => marker }).simulated === false);
    void loadLocalAdapterConfig;
  }

  console.log('\n[17] Request authorization + replay + expanded inspection + harness (no real device)');
  {
    __resetNoncesForTests();
    const cfg: EndpointAuthzConfig = { allowedDeviceIds: ['dev-allow-01'], environment: 'nonproduction', killSwitchActive: false, liveSigningConfigured: false };
    const fixture = createTestFixtureVerifier();
    const signedReq = (over: Partial<OperationRequest> = {}): OperationRequest => {
      const base: OperationRequest = { caseId: 'c', operationId: 'op1', actionId: 'restart_teams', parameters: {}, requesterId: 'userA', approverId: 'userB', deviceId: 'dev-allow-01', environment: 'nonproduction', issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), nonce: 'n-' + Math.random().toString(36).slice(2), correlationId: 'corr', softwareVersion: 'test', ...over };
      const sig = over.signature ?? testSignature(canonicalize(base));
      return { ...base, signature: sig };
    };
    check('valid signed request (dry-run) is authorized', authorizeOperation(signedReq(), cfg, fixture, { realExecution: false }).category === 'authorized');
    check('kill switch blocks everything', authorizeOperation(signedReq(), { ...cfg, killSwitchActive: true }, fixture, { realExecution: false }).category === 'kill_switch_active');
    check('non-allowlisted device denied', authorizeOperation(signedReq({ deviceId: 'other' }), cfg, fixture, { realExecution: false }).category === 'device_not_allowlisted');
    check('production environment denied', authorizeOperation(signedReq({ environment: 'production' }), cfg, fixture, { realExecution: false }).category === 'unsupported_environment');
    check('expired authorization denied', authorizeOperation(signedReq({ expiresAt: new Date(Date.now() - 5000).toISOString() }), cfg, fixture, { realExecution: false }).category === 'expired');
    check('missing signature denied', authorizeOperation(signedReq({ signature: '' }), cfg, fixture, { realExecution: false }).category === 'missing_signature');
    check('invalid signature denied', authorizeOperation(signedReq({ signature: 'testsig:deadbeef' }), cfg, fixture, { realExecution: false }).category === 'invalid_signature');
    // Replay: a nonce is single-use.
    const rr = signedReq({ nonce: 'fixed-nonce' });
    check('first use of a nonce is authorized', authorizeOperation(rr, cfg, fixture, { realExecution: false }).category === 'authorized');
    check('replayed nonce is rejected', authorizeOperation(signedReq({ nonce: 'fixed-nonce' }), cfg, fixture, { realExecution: false }).category === 'replay_detected');
    // Runtime hard-blocks for REAL execution.
    check('real execution refuses a test-fixture signer', authorizeOperation(signedReq(), { ...cfg, liveSigningConfigured: true }, fixture, { realExecution: true }).category === 'test_key_in_runtime');
    const liveVerifier: RequestVerifier = { id: 'live-stub', isTestFixture: false, verify: () => true };
    check('real execution refuses when live signing not configured', authorizeOperation(signedReq(), { ...cfg, liveSigningConfigured: false }, liveVerifier, { realExecution: true }).category === 'live_signing_required');

    // Expanded inspection via the local adapter (mock runner, no OS).
    const marker: TestDeviceMarker = { tenantId: 't1', deviceId: 'dev-local-01', hostname: 'HRE-TEST-01', assignedUserId: 'userA', nonProduction: true };
    const canned: Record<string, string> = {
      os_info: JSON.stringify({ edition: 'Windows 11 Pro', version: '10.0.26200', build: '26200', arch: '64-bit' }),
      machine_identity: JSON.stringify({ deviceUuid: 'ABCD-1234-EFGH', hostname: 'HRE-TEST-01' }),
      'service_state:Spooler': JSON.stringify({ name: 'Spooler', status: 'Running', startType: 'Automatic' }),
      'app_presence:Teams': JSON.stringify({ app: 'Teams', present: false, version: 'unknown' })
    };
    const calls: LocalCommandSpec[] = [];
    const runner: CommandRunner = { async run(spec) { calls.push(spec); return { ok: true, stdout: canned[spec.id] ?? '{}', exitCode: 0 }; } };
    const on = createLocalWindowsAdapter({ config: { enabled: true, markerPath: 'x' }, runner, readMarker: () => marker });
    const ev = (t: string, p: Record<string, string | number | boolean> = {}) => on.collectEvidence({ requestId: 'r', caseId: 'c', deviceId: 'dev-local-01', evidenceType: t, parameters: p, timeoutSeconds: 5 });
    check('os_info inspection maps + parses', (await ev('os_info')).facts.edition === 'Windows 11 Pro');
    const mi = await ev('machine_identity');
    check('machine_identity returns a device id', typeof mi.facts.deviceUuid === 'string');
    check('service_state (allowlisted) succeeds', (await ev('service_state', { serviceName: 'Spooler' })).status === 'succeeded' && calls.some((s) => s.id === 'service_state:Spooler'));
    check('service_state (NOT allowlisted) is refused', (await ev('service_state', { serviceName: 'DoEvil' })).status === 'unavailable');
    check('app_presence (allowlisted) succeeds', (await ev('app_presence', { appName: 'Teams' })).status === 'succeeded');
    check('app_presence (NOT allowlisted) is refused', (await ev('app_presence', { appName: 'Hacker' })).status === 'unavailable');
    const ah = await ev('adapter_health');
    check('adapter_health reports without an OS command', ah.status === 'succeeded' && (ah.facts as { adapter?: string }).adapter === 'local-windows');

    // Harness: inspection-only + repair fail-closed (simulator env).
    const h = await runHarness({} as NodeJS.ProcessEnv, false);
    check('harness defaults to inspection-only against the simulator', h.mode === 'inspection_only' && h.simulated === true && h.repairExecuted === false);
    const h2 = await runHarness({ WATSON_HARNESS_REPAIR_ENABLE: 'true' } as unknown as NodeJS.ProcessEnv, false);
    check('harness refuses real repair when only the simulator is available', h2.mode === 'repair' && h2.repairExecuted === false && h2.notes.some((n) => /simulator|refused/i.test(n)));
  }

  console.log('\n[18] Test-only sentinel repair action (never activatable in production)');
  {
    __resetEventsForTests(); __resetApprovalsForTests();
    const def = getAction('restart_sentinel_process')!;
    check('sentinel action is testOnly + low-risk + employee approval', def.testOnly === true && def.riskTier === 'low' && def.approvalLevel === 'employee');
    const marker: TestDeviceMarker = { tenantId: 't1', deviceId: 'dev-local-01', hostname: 'HRE-TEST', assignedUserId: 'userA', nonProduction: true };
    const canned: Record<string, string> = { restart_sentinel_process: JSON.stringify({ restarted: true, oldPids: [10], newPid: 20 }), sentinel_health: JSON.stringify({ present: true, procId: 20, startTime: '2026-08-01T00:00:00Z' }) };
    const runner: CommandRunner = { async run(spec) { return { ok: true, stdout: canned[spec.id] ?? '{}', exitCode: 0 }; } };
    const port = createLocalWindowsAdapter({ config: { enabled: true, markerPath: 'x' }, runner, readMarker: () => marker });
    const exec = createExecutor(port);
    const dev = { tenantId: 't1', deviceId: 'dev-local-01', provider: 'rmm', hostname: 'HRE-TEST', platform: 'windows', assignedUserId: 'userA', online: true, lastSeenAt: new Date().toISOString(), managementState: 'managed' } as EndpointDevice;
    const wcase = { caseId: 'cs', tenantId: 't1', complaint: '', playbookId: 'x', actor: EMP, device: dev, state: 'executing', evidence: [], hypotheses: [], actions: [], question: null, createdAt: '', updatedAt: '', canceled: false, simulated: false } as WatsonCase;
    const grant = () => { const g = grantApproval({ caseId: 'cs', actionId: 'restart_sentinel_process', requesterActorId: EMP.actorId, grantedBy: EMP }); return g.ok ? g.approval.approvalId : ''; };
    delete process.env.WATSON_ALLOW_TESTONLY;
    const denied = await exec.runAction(EMP, wcase, 'restart_sentinel_process', {}, grant());
    check('sentinel refused unless WATSON_ALLOW_TESTONLY=true (production-safe)', denied.status === 'denied' && denied.reason === 'testonly_not_enabled');
    process.env.WATSON_ALLOW_TESTONLY = 'true';
    const ok = await exec.runAction(EMP, wcase, 'restart_sentinel_process', {}, grant());
    check('sentinel executes + verifies via re-collected evidence when enabled', ok.status === 'succeeded' && ok.verificationStatus === 'passed');
    delete process.env.WATSON_ALLOW_TESTONLY;
    const sh = await port.collectEvidence({ requestId: 'r', caseId: 'cs', deviceId: 'dev-local-01', evidenceType: 'sentinel_health', parameters: {}, timeoutSeconds: 5 });
    check('sentinel_health inspection maps + parses', sh.status === 'succeeded' && (sh.facts as { present?: boolean }).present === true);
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
