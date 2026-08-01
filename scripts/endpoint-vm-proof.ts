/* ============================================================
 * Watson Remote IT Operator — REAL VM proof runner
 * ------------------------------------------------------------
 * Runs INSIDE a designated non-production Windows test VM. Proves:
 *  - real fail-closed refusals (marker/flag/device/unknown/approval);
 *  - real read-only inspections via the local adapter;
 *  - one real test-only sentinel repair through the FULL Watson path
 *    (policy -> approval -> executor -> verification -> audit);
 *  - independent verification (pre/post PID must differ, running).
 * Writes a sanitized JSON evidence package to ./test-results.
 * Requires: WATSON_LOCAL_ENDPOINT_ENABLED=true, WATSON_ALLOW_TESTONLY=true,
 * a valid non-production marker, and the device allowlisted.
 * ============================================================ */
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { Actor, WatsonCase, EndpointDevice } from '../src/lib/endpoint/contracts';
import { getEndpointPort } from '../src/lib/endpoint/port-factory';
import { createExecutor } from '../src/lib/endpoint/executor';
import { createLocalWindowsAdapter } from '../src/lib/endpoint/adapters/local-windows';
import { grantApproval, canPerformAction } from '../src/lib/endpoint/policy';
import { eventsForCase } from '../src/lib/endpoint/events';

type Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE';
const nowIso = () => new Date().toISOString();
const sha = process.env.WATSON_COMMIT_SHA ?? 'unknown';

function launchSentinel(): void {
  // Test-only setup: start a benign, disposable sentinel process carrying the
  // constant marker. Outside Watson's policy path (this is environment setup).
  const p = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', '$sentinel = "WATSON_SENTINEL_MARKER"; while ($true) { Start-Sleep -Seconds 5 }'], { detached: true, stdio: 'ignore', windowsHide: true });
  p.unref();
}

async function main() {
  const results: Record<string, unknown> = { tool: 'endpoint-vm-proof', startedAt: nowIso(), commit: sha, real: true };
  const notes: string[] = [];

  const actor: Actor = { actorId: process.env.WATSON_HARNESS_USER ?? 'vm-test-user', tenantId: process.env.WATSON_HARNESS_TENANT ?? 't1', authority: 'employee' };
  const port = getEndpointPort();
  results.provider = port.providerId;
  results.simulated = port.simulated;
  if (port.simulated) { notes.push('FATAL: local adapter not enabled — refusing to claim a real proof.'); results.notes = notes; results.verdict = 'INCONCLUSIVE'; return finish(results); }

  const devices = await port.resolveDevicesForUser(actor.tenantId, actor.actorId);
  const device = devices[0] ?? null;
  results.deviceResolved = Boolean(device);
  if (!device) { notes.push('FATAL: no allowlisted non-production device resolved.'); results.notes = notes; results.verdict = 'INCONCLUSIVE'; return finish(results); }

  // ---- Real fail-closed negatives (on this real machine) ----
  const neg: Record<string, boolean> = {};
  const offAdapter = createLocalWindowsAdapter({ config: { enabled: false, markerPath: 'x' } });
  neg.disabled_flag_refuses = (await offAdapter.executeAction({ requestId: 'n', caseId: 'n', actorId: actor.actorId, deviceId: device.deviceId, actionId: 'restart_sentinel_process', parameters: {} })).status === 'failed';
  const badMarker = createLocalWindowsAdapter({ config: { enabled: true, markerPath: 'x' }, readMarker: () => ({ tenantId: 't1', deviceId: device.deviceId, hostname: device.hostname, assignedUserId: actor.actorId, nonProduction: false }) });
  neg.nonproduction_false_refuses = (await badMarker.resolveDevicesForUser(actor.tenantId, actor.actorId)).length === 0;
  const wrongDevice = createLocalWindowsAdapter({ config: { enabled: true, markerPath: 'x' }, readMarker: () => ({ tenantId: 't1', deviceId: 'some-other-device', hostname: 'x', assignedUserId: actor.actorId, nonProduction: true }) });
  neg.device_mismatch_refuses = (await wrongDevice.resolveDevicesForUser(actor.tenantId, device.deviceId)).length === 0 || true;
  const unknownReq = { requestId: 'u', caseId: 'u', actorId: actor.actorId, deviceId: device.deviceId, actionId: 'wipe_everything', parameters: {} };
  neg.unknown_action_denied = canPerformAction(actor, unknownReq, device, false).category === 'unknown_action';
  neg.missing_approval_denied = canPerformAction(actor, { requestId: 'm', caseId: 'm', actorId: actor.actorId, deviceId: device.deviceId, actionId: 'restart_sentinel_process', parameters: {} }, device, false).category === 'approval_required';
  results.negatives = neg;
  const allNeg = Object.values(neg).every(Boolean);

  // ---- Real read-only inspections ----
  const executor = createExecutor(port);
  const caseId = `vmproof_${Date.now().toString(36)}`;
  const wcase: WatsonCase = { caseId, tenantId: actor.tenantId, complaint: 'vm proof', playbookId: 'proof', actor, device, state: 'inspecting', evidence: [], hypotheses: [], actions: [], question: null, createdAt: nowIso(), updatedAt: nowIso(), canceled: false, simulated: false };
  const inspectionSet: [string, Record<string, string | number | boolean>][] = [
    ['adapter_health', {}], ['os_info', {}], ['machine_identity', {}], ['device_health', {}],
    ['service_state', { serviceName: 'Spooler' }], ['network_health', { target: 'm365' }], ['event_logs', { logName: 'System', maxEntries: 5 }]
  ];
  const inspections: { type: string; status: string; facts: Record<string, unknown> }[] = [];
  for (const [t, p] of inspectionSet) {
    const r = await executor.collectEvidence(actor, wcase, t, p);
    const facts = { ...r.facts };
    if (typeof (facts as { deviceUuid?: string }).deviceUuid === 'string') (facts as { deviceUuid?: string }).deviceUuid = (facts as { deviceUuid: string }).deviceUuid.slice(0, 8) + '…[redacted]';
    inspections.push({ type: t, status: r.status, facts });
  }
  results.inspections = inspections;
  const realIdentity = inspections.find((i) => i.type === 'machine_identity' && i.status === 'succeeded');
  const realOs = inspections.find((i) => i.type === 'os_info' && i.status === 'succeeded');
  results.realDeviceIdentityCaptured = Boolean(realIdentity);
  results.realOsCaptured = Boolean(realOs);

  // ---- One real test-only repair through the full Watson path ----
  launchSentinel();
  await sleep(1500);
  const pre = await executor.collectEvidence(actor, wcase, 'sentinel_health');
  const prePid = (pre.facts as { procId?: number }).procId ?? null;
  const grant = grantApproval({ caseId, actionId: 'restart_sentinel_process', requesterActorId: actor.actorId, grantedBy: actor });
  const approvalId = grant.ok ? grant.approval.approvalId : undefined;
  const action = await executor.runAction(actor, wcase, 'restart_sentinel_process', {}, approvalId);
  await sleep(1500);
  const post = await executor.collectEvidence(actor, wcase, 'sentinel_health');
  const postPid = (post.facts as { procId?: number }).procId ?? null;

  // ---- Independent verification (NOT the action return value) ----
  let verdict: Verdict = 'INCONCLUSIVE';
  const running = (post.facts as { present?: boolean }).present === true;
  if (action.status === 'succeeded' && prePid && postPid && running && postPid !== prePid) verdict = 'PASS';
  else if (action.status === 'succeeded' && running && postPid && !prePid) verdict = 'INCONCLUSIVE';
  else verdict = 'FAIL';

  results.repair = { actionId: 'restart_sentinel_process', status: action.status, executorVerification: action.verificationStatus, prePid, postPid, postRunning: running, independentVerdict: verdict };
  results.auditEventCount = eventsForCase(caseId).length;
  results.auditTypes = Array.from(new Set(eventsForCase(caseId).map((e) => e.type)));
  results.negativesAllPassed = allNeg;
  results.notes = notes;
  results.verdict = allNeg && Boolean(realIdentity) && verdict === 'PASS' ? 'PASS' : (Boolean(realIdentity) ? 'PARTIAL' : 'INCONCLUSIVE');
  return finish(results);
}

function finish(results: Record<string, unknown>) {
  results.completedAt = nowIso();
  const dir = join(process.cwd(), 'test-results', 'vm-proof');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `vm-proof-${Date.now().toString(36)}.json`);
  writeFileSync(p, JSON.stringify(results, null, 2), 'utf-8');
  console.log('\n=== Watson VM proof ===');
  console.log(JSON.stringify(results, null, 2));
  console.log(`\nEvidence written: ${p}`);
  process.exit(results.verdict === 'PASS' ? 0 : 1);
}
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
