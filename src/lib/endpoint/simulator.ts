// ============================================================
// Watson Remote IT Operator — Deterministic SIMULATOR adapter
// ------------------------------------------------------------
// Implements EndpointOperationsPort with fully deterministic,
// clearly-labeled SIMULATED evidence. No real machine is touched.
// Every result carries provenance.simulated = true and source
// 'simulator'. Used until a real Intune/RMM adapter is connected.
// ============================================================
import type {
  EndpointOperationsPort, EndpointDevice, EvidenceRequest, EvidenceResult, ActionRequest, ActionResult
} from './contracts';

export type ScenarioId =
  | 'healthy'
  | 'process_hang'
  | 'corrupt_cache'
  | 'high_memory'
  | 'low_disk'
  | 'pending_restart'
  | 'network_failure'
  | 'm365_outage'
  | 'endpoint_unavailable';

interface SimDeviceState {
  device: EndpointDevice;
  scenario: ScenarioId;
  teamsState: 'running' | 'not_responding' | 'not_running';
  teamsVersion: string;
  recentCrashes: number;
  cacheCorrupt: boolean;
  memoryPct: number;
  cpuPct: number;
  diskFreeGb: number;
  diskTotalGb: number;
  uptimeHours: number;
  pendingRestart: boolean;
  networkOk: boolean;
  m365Teams: 'healthy' | 'degraded' | 'down';
  // When true, write actions "run" but do not change the failing condition,
  // so deterministic verification will fail (proves unresolved-on-failed-verify).
  repairIneffective: boolean;
}

function baseState(device: EndpointDevice, scenario: ScenarioId): SimDeviceState {
  const s: SimDeviceState = {
    device,
    scenario,
    teamsState: 'running',
    teamsVersion: '24246.1234.3000.1',
    recentCrashes: 0,
    cacheCorrupt: false,
    memoryPct: 46,
    cpuPct: 22,
    diskFreeGb: 180,
    diskTotalGb: 512,
    uptimeHours: 20,
    pendingRestart: false,
    networkOk: true,
    m365Teams: 'healthy',
    repairIneffective: false
  };
  switch (scenario) {
    case 'process_hang': s.teamsState = 'not_responding'; break;
    case 'corrupt_cache': s.recentCrashes = 4; s.cacheCorrupt = true; s.teamsState = 'running'; break;
    case 'high_memory': s.memoryPct = 96; s.teamsState = 'not_responding'; break;
    case 'low_disk': s.diskFreeGb = 2; s.teamsState = 'not_responding'; break;
    case 'pending_restart': s.pendingRestart = true; s.uptimeHours = 730; s.teamsState = 'not_responding'; break;
    case 'network_failure': s.networkOk = false; s.teamsState = 'not_responding'; break;
    case 'm365_outage': s.m365Teams = 'down'; s.teamsState = 'not_responding'; break;
    case 'endpoint_unavailable': s.device = { ...device, online: false, lastSeenAt: new Date(Date.now() - 86400000).toISOString() }; break;
    default: break;
  }
  return s;
}

export interface Simulator extends EndpointOperationsPort {
  seedDevice(userId: string, device: EndpointDevice, scenario: ScenarioId): void;
  setScenario(deviceId: string, scenario: ScenarioId): void;
  setRepairIneffective(deviceId: string, value: boolean): void;
  reset(): void;
}

export function createSimulator(): Simulator {
  const byDevice = new Map<string, SimDeviceState>();
  const byUser = new Map<string, string[]>(); // userId -> deviceIds
  const canceled = new Set<string>();
  let idc = 0;
  const now = () => new Date().toISOString();

  function ensureDefault(tenantId: string, userId: string) {
    if (byUser.has(userId)) return;
    const device: EndpointDevice = {
      tenantId, deviceId: `sim-${userId.replace(/[^a-z0-9]/gi, '').slice(0, 10)}-01`,
      provider: 'simulator', hostname: `HRE-SIM-${(byUser.size + 1).toString().padStart(2, '0')}`,
      platform: 'windows', assignedUserId: userId, online: true, lastSeenAt: now(),
      managementState: 'managed'
    };
    byDevice.set(device.deviceId, baseState(device, 'healthy'));
    byUser.set(userId, [device.deviceId]);
  }

  function evid(req: EvidenceRequest, status: EvidenceResult['status'], facts: Record<string, unknown>, redactions: string[] = []): EvidenceResult {
    return {
      requestId: req.requestId, collectedAt: now(), source: 'simulator', status, facts, redactions,
      provenance: { provider: 'simulator', commandId: `sim-${(++idc).toString(36)}`, correlationId: req.caseId, simulated: true }
    };
  }

  return {
    providerId: 'simulator',
    simulated: true,

    seedDevice(userId, device, scenario) {
      byDevice.set(device.deviceId, baseState(device, scenario));
      const list = byUser.get(userId) ?? [];
      if (!list.includes(device.deviceId)) list.push(device.deviceId);
      byUser.set(userId, list);
    },
    setScenario(deviceId, scenario) {
      const st = byDevice.get(deviceId);
      if (st) byDevice.set(deviceId, baseState(st.device, scenario));
    },
    setRepairIneffective(deviceId, value) {
      const st = byDevice.get(deviceId);
      if (st) st.repairIneffective = value;
    },
    reset() { byDevice.clear(); byUser.clear(); canceled.clear(); },

    async resolveDevicesForUser(tenantId, userId) {
      ensureDefault(tenantId, userId);
      return (byUser.get(userId) ?? []).map((id) => byDevice.get(id)!.device).filter((d) => d.tenantId === tenantId);
    },

    async collectEvidence(request) {
      const st = byDevice.get(request.deviceId);
      if (!st) return evid(request, 'unavailable', { reason: 'device_not_found' });
      if (!st.device.online) return evid(request, 'unavailable', { reason: 'device_offline', online: false });
      switch (request.evidenceType) {
        case 'device_health':
          return evid(request, 'succeeded', {
            online: st.device.online, uptimeHours: st.uptimeHours, pendingRestart: st.pendingRestart,
            cpuPct: st.cpuPct, memoryPct: st.memoryPct, diskFreeGb: st.diskFreeGb, diskTotalGb: st.diskTotalGb
          });
        case 'process_health':
          return evid(request, 'succeeded', {
            processName: 'Teams', state: st.teamsState, pid: st.teamsState === 'not_running' ? null : 8123, memoryMB: 540
          });
        case 'teams_health':
          return evid(request, 'succeeded', {
            installed: true, version: st.teamsVersion, recentCrashes: st.recentCrashes,
            lastCrashSignature: st.recentCrashes > 0 ? 'APPCRASH:ms-teams.exe:cache' : null, cacheCorrupt: st.cacheCorrupt
          });
        case 'event_logs': {
          const entries = st.recentCrashes > 0
            ? Array.from({ length: Math.min(st.recentCrashes, Number(request.parameters?.maxEntries ?? 5)) }).map((_, i) => ({
                id: 1000 + i, level: 'Error', source: 'Application Error', message: 'Faulting application ms-teams.exe' }))
            : [{ id: 7036, level: 'Information', source: 'Service Control Manager', message: 'nominal' }];
          return evid(request, 'succeeded', { logName: String(request.parameters?.logName ?? 'Application'), entries });
        }
        case 'network_health':
          return evid(request, 'succeeded', { reachable: st.networkOk, target: String(request.parameters?.target ?? 'm365'), latencyMs: st.networkOk ? 34 : null });
        case 'm365_service_health':
          return evid(request, 'succeeded', { teams: st.m365Teams, overall: st.m365Teams === 'healthy' ? 'healthy' : 'advisory' });
        case 'support_bundle':
          return evid(request, 'succeeded', { bundleId: `bundle-${(++idc).toString(36)}`, items: ['device_health', 'process_health', 'teams_health', 'event_logs', 'network_health'] });
        default:
          return evid(request, 'unavailable', { reason: 'unsupported_evidence_type' });
      }
    },

    async executeAction(request) {
      const started = now();
      const st = byDevice.get(request.deviceId);
      const done = (status: ActionResult['status'], reason?: string): ActionResult => ({
        requestId: request.requestId, status, startedAt: started, completedAt: now(), evidence: [], verificationStatus: 'not_run', reason
      });
      if (!st) return done('failed', 'device_not_found');
      if (canceled.has(request.caseId)) return done('canceled', 'session_canceled');
      if (!st.device.online) return done('failed', 'device_offline');

      // Apply the deterministic effect of the action UNLESS repairs are set ineffective.
      if (!st.repairIneffective) {
        switch (request.actionId) {
          case 'restart_teams':
            // Restart clears a hung/not-running process (does not fix disk/network/service).
            if (st.teamsState !== 'running') st.teamsState = 'running';
            break;
          case 'clear_teams_cache':
            st.cacheCorrupt = false; st.recentCrashes = 0;
            if (st.scenario === 'low_disk') st.diskFreeGb = 24; // cache clear frees space
            if (st.teamsState !== 'running') st.teamsState = 'running';
            break;
          case 'trigger_intune_sync':
            // Sync is acknowledged; does not by itself fix an app fault.
            break;
          default:
            break;
        }
      }
      return done('succeeded');
    },

    async cancelAction(requestId) {
      // Best-effort: mark associated case canceled is handled by orchestrator; here no-op sink.
      void requestId;
    }
  };
}
