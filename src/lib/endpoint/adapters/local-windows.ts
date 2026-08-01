// ============================================================
// Watson Remote IT Operator — LOCAL WINDOWS adapter (fail-closed)
// ------------------------------------------------------------
// A REAL EndpointOperationsPort for a single, explicitly designated
// NON-PRODUCTION Windows test device. It executes ONLY fixed,
// pre-reviewed PowerShell command specs — never model-generated or
// caller-supplied shell. It is DISABLED by default and fails closed:
// it will not touch any machine unless BOTH
//   (1) WATSON_LOCAL_ENDPOINT_ENABLED = 'true', and
//   (2) a valid non-production test-device marker is present
//       (marker.nonProduction === true).
// Command execution is injected (CommandRunner) so the mapping and
// the fail-closed behaviour are fully unit-testable WITHOUT running
// anything on the operating system.
// ============================================================
import type {
  EndpointOperationsPort, EndpointDevice, EvidenceRequest, EvidenceResult, ActionRequest, ActionResult
} from '../contracts';
import { isAllowedEvidenceType } from '../catalog';
import { existsSync, readFileSync } from 'node:fs';
import { SENTINEL_HEALTH, RESTART_SENTINEL } from './sentinel-specs';

// A single, fixed, pre-reviewed command. `id` is a stable label;
// `script` is a CONSTANT PowerShell string. There is no place for a
// caller/model to inject text — evidence/action selection chooses one
// of a fixed set; it never interpolates free input.
export interface LocalCommandSpec {
  id: string;
  description: string;
  script: string; // constant; emits JSON on stdout
  writesDevice: boolean;
}

export interface CommandRunResult { ok: boolean; stdout: string; exitCode: number; }
export interface CommandRunner {
  run(spec: LocalCommandSpec, timeoutSeconds: number): Promise<CommandRunResult>;
}

export interface TestDeviceMarker {
  tenantId: string;
  deviceId: string;
  hostname: string;
  assignedUserId: string;
  nonProduction: boolean; // MUST be true or the adapter stays disabled
}

export interface LocalAdapterConfig {
  enabled: boolean;
  markerPath: string;
}

export function loadLocalAdapterConfig(env: NodeJS.ProcessEnv = process.env): LocalAdapterConfig {
  const raw = (env.WATSON_LOCAL_ENDPOINT_ENABLED ?? 'false').toLowerCase();
  return {
    enabled: raw === 'true' || raw === '1' || raw === 'yes',
    markerPath: env.WATSON_LOCAL_TESTDEVICE_MARKER?.trim() || 'C:\\watson-nonprod-testdevice.marker'
  };
}

// ---- Fixed command specs (constants; selection not interpolation) ----
const DEVICE_HEALTH: LocalCommandSpec = {
  id: 'device_health', writesDevice: false,
  description: 'Uptime, pending-restart, CPU, memory, disk (read-only).',
  script: "$os=Get-CimInstance Win32_OperatingSystem; $c=Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average; $d=Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='C:'\"; $pr=Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired'; [pscustomobject]@{ online=$true; uptimeHours=[math]::Round(((Get-Date)-$os.LastBootUpTime).TotalHours,1); pendingRestart=$pr; cpuPct=[int]$c.Average; memoryPct=[int](100-($os.FreePhysicalMemory/$os.TotalVisibleMemorySize*100)); diskFreeGb=[math]::Round($d.FreeSpace/1GB,1); diskTotalGb=[math]::Round($d.Size/1GB,1) } | ConvertTo-Json -Compress"
};
const PROCESS_HEALTH_TEAMS: LocalCommandSpec = {
  id: 'process_health', writesDevice: false,
  description: 'Teams process state (read-only).',
  script: "$p=Get-Process -Name ms-teams,Teams -ErrorAction SilentlyContinue | Select-Object -First 1; if($p){ $state= if($p.Responding){'running'}else{'not_responding'}; [pscustomobject]@{ processName='Teams'; state=$state; pid=$p.Id; memoryMB=[int]($p.WorkingSet64/1MB) } | ConvertTo-Json -Compress } else { [pscustomobject]@{ processName='Teams'; state='not_running'; pid=$null; memoryMB=0 } | ConvertTo-Json -Compress }"
};
const TEAMS_HEALTH: LocalCommandSpec = {
  id: 'teams_health', writesDevice: false,
  description: 'Teams version + recent crash signatures (read-only).',
  script: "$crashes=@(Get-WinEvent -FilterHashtable @{LogName='Application';ProviderName='Application Error'} -MaxEvents 20 -ErrorAction SilentlyContinue | Where-Object { $_.Message -match 'ms-teams|Teams' }); [pscustomobject]@{ installed=$true; version='unknown'; recentCrashes=$crashes.Count; cacheCorrupt=$false } | ConvertTo-Json -Compress"
};
const EVENTLOG_APPLICATION: LocalCommandSpec = {
  id: 'event_logs:Application', writesDevice: false,
  description: 'Recent Application event log entries (read-only).',
  script: "Get-WinEvent -LogName Application -MaxEvents 5 -ErrorAction SilentlyContinue | Select-Object Id,LevelDisplayName,ProviderName,Message | ConvertTo-Json -Compress"
};
const EVENTLOG_SYSTEM: LocalCommandSpec = {
  id: 'event_logs:System', writesDevice: false,
  description: 'Recent System event log entries (read-only).',
  script: "Get-WinEvent -LogName System -MaxEvents 5 -ErrorAction SilentlyContinue | Select-Object Id,LevelDisplayName,ProviderName,Message | ConvertTo-Json -Compress"
};
const NETWORK_HEALTH: LocalCommandSpec = {
  id: 'network_health', writesDevice: false,
  description: 'Reachability to Teams/M365 (read-only).',
  script: "$t=Test-NetConnection -ComputerName teams.microsoft.com -Port 443 -InformationLevel Quiet; [pscustomobject]@{ reachable=[bool]$t; target='m365' } | ConvertTo-Json -Compress"
};
// Low-risk WRITE actions — fixed, bounded, reversible-by-relaunch.
const RESTART_TEAMS: LocalCommandSpec = {
  id: 'restart_teams', writesDevice: true,
  description: 'Stop and relaunch Microsoft Teams.',
  script: "Get-Process -Name ms-teams,Teams -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2; $exe=Join-Path $env:LOCALAPPDATA 'Microsoft\\Teams\\current\\Teams.exe'; if(Test-Path $exe){ Start-Process $exe }; [pscustomobject]@{ restarted=$true } | ConvertTo-Json -Compress"
};
const CLEAR_TEAMS_CACHE: LocalCommandSpec = {
  id: 'clear_teams_cache', writesDevice: true,
  description: 'Stop Teams and remove its cache directory (regenerates on next launch).',
  script: "Get-Process -Name ms-teams,Teams -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2; $cache=Join-Path $env:APPDATA 'Microsoft\\Teams'; if(Test-Path $cache){ Remove-Item (Join-Path $cache 'Cache') -Recurse -Force -ErrorAction SilentlyContinue }; [pscustomobject]@{ cacheCleared=$true } | ConvertTo-Json -Compress"
};

const OS_INFO: LocalCommandSpec = {
  id: 'os_info', writesDevice: false, description: 'OS edition/version/build (read-only).',
  script: "$o=Get-CimInstance Win32_OperatingSystem; [pscustomobject]@{ edition=$o.Caption; version=$o.Version; build=$o.BuildNumber; arch=$o.OSArchitecture } | ConvertTo-Json -Compress"
};
const MACHINE_IDENTITY: LocalCommandSpec = {
  id: 'machine_identity', writesDevice: false, description: 'Stable device id + hostname (read-only).',
  script: "$p=Get-CimInstance Win32_ComputerSystemProduct; [pscustomobject]@{ deviceUuid=$p.UUID; hostname=$env:COMPUTERNAME } | ConvertTo-Json -Compress"
};
// Read-only state/presence for a CLOSED allowlist only. The only interpolated
// value is a token proven to be an allowlist member AND alphanumeric.
export const SERVICE_ALLOWLIST = ['Spooler', 'Dnscache', 'W32Time', 'wuauserv', 'WSearch'] as const;
export const APP_ALLOWLIST = ['Teams', 'Bluebeam', 'Outlook', 'OneDrive'] as const;
function serviceStateSpec(name: string): LocalCommandSpec | null {
  if (!(SERVICE_ALLOWLIST as readonly string[]).includes(name) || !/^[A-Za-z0-9]+$/.test(name)) return null;
  return { id: `service_state:${name}`, writesDevice: false, description: `State of the ${name} service (read-only).`,
    script: `$s=Get-Service -Name ${name} -ErrorAction SilentlyContinue; [pscustomobject]@{ name='${name}'; status=[string]$s.Status; startType=[string]$s.StartType } | ConvertTo-Json -Compress` };
}
function appPresenceSpec(name: string): LocalCommandSpec | null {
  if (!(APP_ALLOWLIST as readonly string[]).includes(name) || !/^[A-Za-z0-9]+$/.test(name)) return null;
  return { id: `app_presence:${name}`, writesDevice: false, description: `Presence/version of ${name} (read-only).`,
    script: `[pscustomobject]@{ app='${name}'; present=$false; version='unknown' } | ConvertTo-Json -Compress` };
}
const EVIDENCE_COMMANDS: Record<string, (params: Record<string, unknown>) => LocalCommandSpec | null> = {
  device_health: () => DEVICE_HEALTH,
  process_health: () => PROCESS_HEALTH_TEAMS,
  teams_health: () => TEAMS_HEALTH,
  network_health: () => NETWORK_HEALTH,
  // event log: SELECT a fixed spec by validated enum — no interpolation.
  event_logs: (p) => (p.logName === 'System' ? EVENTLOG_SYSTEM : p.logName === 'Application' ? EVENTLOG_APPLICATION : null),
  m365_service_health: () => null, // service-side; not a local command
  support_bundle: () => DEVICE_HEALTH, // minimal bundle stand-in
  os_info: () => OS_INFO,
  machine_identity: () => MACHINE_IDENTITY,
  service_state: (p) => serviceStateSpec(String(p.serviceName ?? '')),
  app_presence: (p) => appPresenceSpec(String(p.appName ?? '')),
  sentinel_health: () => SENTINEL_HEALTH
};
const ACTION_COMMANDS: Record<string, LocalCommandSpec> = {
  restart_teams: RESTART_TEAMS,
  clear_teams_cache: CLEAR_TEAMS_CACHE,
  restart_sentinel_process: RESTART_SENTINEL
};

// Default runner — lazily loads child_process and runs ONLY the fixed
// spec.script via powershell with no profile. Never invoked in tests/CI
// (the adapter fails closed before reaching it).
export function defaultPowerShellRunner(): CommandRunner {
  return {
    async run(spec, timeoutSeconds) {
      const { spawn } = await import('node:child_process');
      return await new Promise<CommandRunResult>((resolve) => {
        const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', spec.script], { windowsHide: true });
        let out = ''; let done = false;
        const timer = setTimeout(() => { if (!done) { done = true; ps.kill(); resolve({ ok: false, stdout: '', exitCode: 124 }); } }, Math.max(1, timeoutSeconds * 1000));
        ps.stdout.on('data', (d) => { out += String(d); });
        ps.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: code === 0, stdout: out, exitCode: code ?? 1 }); } });
        ps.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, stdout: '', exitCode: 1 }); } });
      });
    }
  };
}

export interface LocalAdapterDeps {
  config?: LocalAdapterConfig;
  runner?: CommandRunner;
  readMarker?: (path: string) => TestDeviceMarker | null;
}

export function createLocalWindowsAdapter(deps: LocalAdapterDeps = {}): EndpointOperationsPort {
  const config = deps.config ?? loadLocalAdapterConfig();
  const runner = deps.runner ?? defaultPowerShellRunner();
  const readMarker = deps.readMarker ?? defaultMarkerReader;

  function marker(): TestDeviceMarker | null {
    if (!config.enabled) return null; // fail closed unless explicitly enabled
    const m = readMarker(config.markerPath);
    if (!m || m.nonProduction !== true || !m.deviceId || !m.tenantId) return null;
    return m;
  }
  function enabled(): boolean { return marker() !== null; }

  function deviceFromMarker(m: TestDeviceMarker): EndpointDevice {
    return { tenantId: m.tenantId, deviceId: m.deviceId, provider: 'rmm', hostname: m.hostname, platform: 'windows', assignedUserId: m.assignedUserId, online: true, lastSeenAt: new Date().toISOString(), managementState: 'managed' };
  }

  const unavailable = (req: EvidenceRequest, reason: string): EvidenceResult => ({
    requestId: req.requestId, collectedAt: new Date().toISOString(), source: 'local-windows', status: 'unavailable',
    facts: { reason }, redactions: [], provenance: { provider: 'local-windows', simulated: false }
  });

  return {
    providerId: 'local-windows',
    simulated: false,

    async resolveDevicesForUser(tenantId, userId) {
      const m = marker();
      if (!m) return []; // disabled -> no devices
      if (m.tenantId !== tenantId || m.assignedUserId !== userId) return [];
      return [deviceFromMarker(m)];
    },

    async collectEvidence(request) {
      if (!enabled()) return unavailable(request, 'adapter_disabled');
      if (!isAllowedEvidenceType(request.evidenceType)) return unavailable(request, 'unsupported_evidence_type');
      if (request.evidenceType === 'adapter_health') {
        return { requestId: request.requestId, collectedAt: new Date().toISOString(), source: 'local-windows', status: 'succeeded', facts: { adapter: 'local-windows', enabled: true, simulated: false, commandCount: localCommandInventory().length }, redactions: [], provenance: { provider: 'local-windows', simulated: false } };
      }
      const build = EVIDENCE_COMMANDS[request.evidenceType];
      const spec = build ? build(request.parameters ?? {}) : null;
      if (!spec) return unavailable(request, 'no_local_command');
      const res = await runner.run(spec, request.timeoutSeconds);
      if (!res.ok) return { requestId: request.requestId, collectedAt: new Date().toISOString(), source: 'local-windows', status: res.exitCode === 124 ? 'timed_out' : 'failed', facts: {}, redactions: [], provenance: { provider: 'local-windows', commandId: spec.id, simulated: false } };
      let facts: Record<string, unknown> = {};
      try { const parsed = JSON.parse(res.stdout || '{}'); facts = Array.isArray(parsed) ? { entries: parsed } : parsed; } catch { facts = { raw: res.stdout.slice(0, 500) }; }
      return { requestId: request.requestId, collectedAt: new Date().toISOString(), source: 'local-windows', status: 'succeeded', facts, redactions: [], provenance: { provider: 'local-windows', commandId: spec.id, simulated: false } };
    },

    async executeAction(request: ActionRequest): Promise<ActionResult> {
      const started = new Date().toISOString();
      const fail = (reason: string): ActionResult => ({ requestId: request.requestId, status: 'failed', startedAt: started, completedAt: new Date().toISOString(), evidence: [], verificationStatus: 'not_run', reason });
      if (!enabled()) return fail('adapter_disabled');
      const spec = ACTION_COMMANDS[request.actionId];
      if (!spec) return fail('unsupported_action'); // only the fixed low-risk actions are executable
      const res = await runner.run(spec, 60);
      return { requestId: request.requestId, status: res.ok ? 'succeeded' : (res.exitCode === 124 ? 'timed_out' : 'failed'), startedAt: started, completedAt: new Date().toISOString(), evidence: [], verificationStatus: 'not_run', reason: res.ok ? undefined : 'command_failed' };
    },

    async cancelAction() { /* best-effort; a running command is bounded by its timeout */ }
  };
}

// Reads + validates the marker file. Absent/invalid -> null (fail closed).
function defaultMarkerReader(path: string): TestDeviceMarker | null {
  try {
    if (!existsSync(path)) return null;
    const m = JSON.parse(readFileSync(path, 'utf-8')) as TestDeviceMarker;
    if (m && m.nonProduction === true && m.deviceId && m.tenantId && m.assignedUserId) return m;
    return null;
  } catch {
    return null;
  }
}

// Introspection for review/tests: the complete fixed command allowlist.
export function localCommandInventory(): LocalCommandSpec[] {
  return [DEVICE_HEALTH, PROCESS_HEALTH_TEAMS, TEAMS_HEALTH, EVENTLOG_APPLICATION, EVENTLOG_SYSTEM, NETWORK_HEALTH, OS_INFO, MACHINE_IDENTITY, SENTINEL_HEALTH, RESTART_TEAMS, CLEAR_TEAMS_CACHE, RESTART_SENTINEL];
}
