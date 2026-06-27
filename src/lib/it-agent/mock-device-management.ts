// ============================================================
// Watson — H&R AI IT Agent : MOCK Device / RMM Connector
// ------------------------------------------------------------
// Simulates Intune / NinjaOne / Atera style device management.
// NEVER calls a real RMM. Future adapters share this interface.
// ============================================================
import { db, uuid, nowIso } from '../store/db';
import { writeAudit } from './audit';
import type { Actor, MockDevice } from './types';

export interface DeviceConnector {
  readonly id: string;
  readonly mode: 'mock' | 'live';
  lookupDeviceByEmail(email: string, actor: Actor): MockDevice | null;
  getDevice(deviceId: string, actor: Actor): MockDevice | null;
  checkDeviceStatus(deviceId: string, actor: Actor): Record<string, unknown> | null;
  triggerSyncMock(deviceId: string, actor: Actor): { syncQueued: boolean; simulatedAt: string };
  collectDiagnosticsMock(deviceId: string, actor: Actor): { bundleId: string; items: string[]; simulatedAt: string };
}

function audit(actor: Actor, op: string, target: string, meta: Record<string, unknown>) {
  writeAudit({
    actorType: actor.type,
    actorId: actor.id,
    action: op.endsWith('Mock') ? 'mock_action_executed' : 'connector_mock_called',
    targetType: 'device_rmm',
    targetId: target,
    metadata: { connector: 'mock-device-management', op, mode: 'mock', ...meta }
  });
}

function byEmail(email: string): MockDevice | null {
  const e = email.trim().toLowerCase();
  return db().mockDevices.find((d) => d.ownerEmail.toLowerCase() === e) ?? null;
}
function byId(id: string): MockDevice | null {
  return db().mockDevices.find((d) => d.id === id) ?? null;
}

export const mockDevice: DeviceConnector = {
  id: 'mock-device-management',
  mode: 'mock',

  lookupDeviceByEmail(email, actor) {
    const d = byEmail(email);
    audit(actor, 'lookupDeviceByEmail', email, { found: Boolean(d) });
    return d;
  },
  getDevice(deviceId, actor) {
    const d = byId(deviceId);
    audit(actor, 'getDevice', deviceId, { found: Boolean(d) });
    return d;
  },
  checkDeviceStatus(deviceId, actor) {
    const d = byId(deviceId);
    audit(actor, 'checkDeviceStatus', deviceId, { found: Boolean(d) });
    if (!d) return null;
    const diskPct = Math.round((d.diskFreeGb / d.diskTotalGb) * 100);
    return {
      deviceId: d.id,
      deviceName: d.deviceName,
      os: `${d.os} ${d.osVersion}`,
      serialNumber: d.serialNumber,
      lastCheckIn: d.lastCheckIn,
      diskFreeGb: d.diskFreeGb,
      diskTotalGb: d.diskTotalGb,
      diskFreePct: diskPct,
      antivirusStatus: d.antivirusStatus,
      patchStatus: d.patchStatus,
      complianceStatus: d.complianceStatus,
      remoteSupportAvailable: d.remoteSupportAvailable,
      managedBy: d.managedBy,
      health: diskPct < 10 || d.complianceStatus === 'non_compliant' ? 'degraded' : 'ok'
    };
  },
  triggerSyncMock(deviceId, actor) {
    const result = { syncQueued: true, simulatedAt: nowIso() };
    audit(actor, 'triggerSyncMock', deviceId, result);
    return result;
  },
  collectDiagnosticsMock(deviceId, actor) {
    const result = {
      bundleId: 'diag-' + uuid(),
      items: ['event_logs', 'disk_report', 'network_report', 'av_report', 'patch_report'],
      simulatedAt: nowIso()
    };
    audit(actor, 'collectDiagnosticsMock', deviceId, { bundleId: result.bundleId });
    return result;
  }
};

export function deviceConnectorStatus() {
  return {
    id: mockDevice.id,
    label: 'Device / RMM (Mock)',
    mode: mockDevice.mode,
    healthy: true,
    note: 'Deterministic mock. No real Intune/NinjaOne/Atera calls.',
    futureAdapters: ['IntuneConnector', 'NinjaOneConnector', 'AteraConnector']
  };
}
