/* ============================================================
 * Watson Remote IT Operator — real-device validation harness
 * ------------------------------------------------------------
 * SAFE BY DEFAULT: inspection-only, dry-run, real repair DISABLED.
 * Uses getEndpointPort(): the simulator unless the local adapter is
 * explicitly enabled AND a valid non-production marker + allowlisted
 * device are present. Real repair additionally requires a SEPARATE
 * explicit flag (WATSON_HARNESS_REPAIR_ENABLE=true) and still fails
 * closed here. Writes structured, redacted evidence to a results dir.
 *
 * Run:  npm run endpoint:harness
 * ============================================================ */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Actor, WatsonCase, EvidenceResult } from '../src/lib/endpoint/contracts';
import { getEndpointPort } from '../src/lib/endpoint/port-factory';
import { createExecutor } from '../src/lib/endpoint/executor';
import { loadLocalAdapterConfig } from '../src/lib/endpoint/adapters/local-windows';
import { loadEndpointAuthzConfig } from '../src/lib/endpoint/authz';

const INSPECTION_SET = ['adapter_health', 'os_info', 'machine_identity', 'device_health', 'process_health', 'network_health', 'service_state', 'app_presence'];

function redact(facts: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...facts };
  if (typeof out.deviceUuid === 'string') out.deviceUuid = out.deviceUuid.slice(0, 8) + '…[redacted]';
  return out;
}

export interface HarnessResult {
  mode: 'inspection_only' | 'dry_run' | 'repair';
  provider: string;
  simulated: boolean;
  deviceResolved: boolean;
  deviceId: string | null;
  environment: string;
  repairEnabled: boolean;
  repairExecuted: boolean;
  inspections: { evidenceType: string; status: string; facts: Record<string, unknown> }[];
  notes: string[];
  evidencePath: string | null;
}

export async function runHarness(env: NodeJS.ProcessEnv = process.env, writeEvidence = true): Promise<HarnessResult> {
  const notes: string[] = [];
  const adapterCfg = loadLocalAdapterConfig(env);
  const authzCfg = loadEndpointAuthzConfig(env);
  const repairEnabled = (env.WATSON_HARNESS_REPAIR_ENABLE ?? 'false').toLowerCase() === 'true';
  const mode: HarnessResult['mode'] = repairEnabled ? 'repair' : ((env.WATSON_HARNESS_DRY_RUN ?? 'false').toLowerCase() === 'true' ? 'dry_run' : 'inspection_only');

  const port = getEndpointPort(env);
  if (port.simulated) notes.push('Running against the SIMULATOR (local adapter not enabled). No real machine is touched.');
  if (!adapterCfg.enabled) notes.push('WATSON_LOCAL_ENDPOINT_ENABLED is not true -> local adapter disabled.');
  if (authzCfg.allowedDeviceIds.length === 0) notes.push('No device is allowlisted (WATSON_ENDPOINT_ALLOWED_DEVICE_IDS empty).');
  if (authzCfg.killSwitchActive) notes.push('KILL SWITCH ACTIVE -> all execution blocked.');

  const actor: Actor = { actorId: env.WATSON_HARNESS_USER ?? 'harness-user', tenantId: env.WATSON_HARNESS_TENANT ?? 't1', authority: 'employee' };
  const devices = await port.resolveDevicesForUser(actor.tenantId, actor.actorId);
  const device = devices[0] ?? null;
  const executor = createExecutor(port);
  const wcase: WatsonCase = { caseId: `harness_${Date.now().toString(36)}`, tenantId: actor.tenantId, complaint: 'harness inspection', playbookId: 'harness', actor, device, state: 'inspecting', evidence: [], hypotheses: [], actions: [], question: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), canceled: false, simulated: port.simulated };

  const inspections: HarnessResult['inspections'] = [];
  if (device) {
    for (const t of INSPECTION_SET) {
      const params: Record<string, string | number | boolean> = t === 'service_state' ? { serviceName: 'Spooler' } : t === 'app_presence' ? { appName: 'Teams' } : {};
      const r: EvidenceResult = await executor.collectEvidence(actor, wcase, t, params);
      inspections.push({ evidenceType: t, status: r.status, facts: redact(r.facts) });
    }
  } else {
    notes.push('No designated device resolved -> inspection skipped (fail closed).');
  }

  // Repair is HARD-DISABLED unless explicitly enabled AND running on a real,
  // allowlisted device. It never runs against the simulator or here.
  let repairExecuted = false;
  if (mode === 'repair') {
    if (port.simulated) notes.push('Repair requested but provider is the simulator -> refused (no real device).');
    else if (!device) notes.push('Repair requested but no allowlisted device resolved -> refused.');
    else if (!authzCfg.liveSigningConfigured) notes.push('Repair requested but live signing not configured -> refused.');
    else notes.push('Repair path reached a real device — this harness still requires a signed OperationRequest via authorizeOperation before executing.');
  }

  const result: HarnessResult = {
    mode, provider: port.providerId, simulated: port.simulated, deviceResolved: Boolean(device),
    deviceId: device?.deviceId ?? null, environment: authzCfg.environment, repairEnabled, repairExecuted,
    inspections, notes, evidencePath: null
  };

  if (writeEvidence) {
    const dir = join(process.cwd(), 'test-results', 'endpoint-harness');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `harness-${wcase.caseId}.json`);
    writeFileSync(p, JSON.stringify(result, null, 2), 'utf-8');
    result.evidencePath = p;
  }
  return result;
}

// Direct invocation.
if (process.argv[1] && process.argv[1].endsWith('endpoint-harness.ts')) {
  runHarness().then((r) => {
    console.log('\n=== Watson endpoint harness ===');
    console.log(`mode=${r.mode} provider=${r.provider} simulated=${r.simulated} device=${r.deviceId ?? '(none)'} env=${r.environment} repairEnabled=${r.repairEnabled} repairExecuted=${r.repairExecuted}`);
    console.log('inspections:'); r.inspections.forEach((i) => console.log(`  - ${i.evidenceType}: ${i.status}`));
    console.log('notes:'); r.notes.forEach((n) => console.log(`  * ${n}`));
    if (r.evidencePath) console.log(`evidence written: ${r.evidencePath}`);
    process.exit(0);
  }).catch((e) => { console.error('FATAL', e); process.exit(2); });
}
