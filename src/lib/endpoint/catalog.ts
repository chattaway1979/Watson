// ============================================================
// Watson Remote IT Operator — Action Catalog
// ------------------------------------------------------------
// Typed, allowlisted actions ONLY. Every action declares risk,
// authority, approval, allowed parameters, preconditions,
// timeout, verification, rollback/compensation and audit fields.
// There is NO parameter anywhere that accepts free-form command,
// script, or shell text.
// ============================================================
import type { ActionDefinition } from './contracts';

// Evidence types the endpoint may be asked to collect (read-only allowlist).
export const ALLOWED_EVIDENCE_TYPES = [
  'device_health',        // online, uptime, pending restart, cpu, memory, disk
  'process_health',       // process state for a named managed process (e.g. Teams)
  'event_logs',           // relevant Windows event entries
  'network_health',       // reachability / connectivity
  'teams_health',         // Teams version + recent crash signatures
  'm365_service_health',  // Microsoft 365 service status
  'support_bundle'        // aggregated diagnostic bundle
] as const;
export type EvidenceType = (typeof ALLOWED_EVIDENCE_TYPES)[number];

export function isAllowedEvidenceType(t: string): t is EvidenceType {
  return (ALLOWED_EVIDENCE_TYPES as readonly string[]).includes(t);
}

const A = (d: ActionDefinition): ActionDefinition => d;

export const ACTION_CATALOG: ActionDefinition[] = [
  // -------------------- READ-ONLY DIAGNOSTICS --------------------
  A({
    actionId: 'collect_device_health',
    displayName: 'Check device health',
    kind: 'read_only',
    platform: ['windows'],
    riskTier: 'low',
    approvalLevel: 'none',
    requiredAuthority: 'system',
    allowedParameters: {},
    preconditions: ['device_managed'],
    timeoutSeconds: 30,
    verification: [],
    rollbackOrCompensation: ['none_required_read_only'],
    auditFields: ['actor', 'tenant', 'device', 'evidenceType', 'status'],
    changesDevice: false
  }),
  A({
    actionId: 'collect_process_health',
    displayName: 'Check application process',
    kind: 'read_only',
    platform: ['windows'],
    riskTier: 'low',
    approvalLevel: 'none',
    requiredAuthority: 'system',
    allowedParameters: {
      processName: { type: 'enum', required: true, enum: ['Teams', 'ms-teams', 'Outlook', 'OneDrive'], description: 'Managed process to inspect' }
    },
    preconditions: ['device_managed'],
    timeoutSeconds: 30,
    verification: [],
    rollbackOrCompensation: ['none_required_read_only'],
    auditFields: ['actor', 'tenant', 'device', 'evidenceType', 'status'],
    changesDevice: false
  }),
  A({
    actionId: 'collect_event_logs',
    displayName: 'Check Windows event logs',
    kind: 'read_only',
    platform: ['windows'],
    riskTier: 'low',
    approvalLevel: 'none',
    requiredAuthority: 'system',
    allowedParameters: {
      logName: { type: 'enum', required: true, enum: ['Application', 'System'], description: 'Event log to read' },
      maxEntries: { type: 'number', required: false, description: 'Max entries (bounded server-side)' }
    },
    preconditions: ['device_managed'],
    timeoutSeconds: 45,
    verification: [],
    rollbackOrCompensation: ['none_required_read_only'],
    auditFields: ['actor', 'tenant', 'device', 'evidenceType', 'status'],
    changesDevice: false
  }),
  A({
    actionId: 'collect_network_health',
    displayName: 'Check network connectivity',
    kind: 'read_only',
    platform: ['windows'],
    riskTier: 'low',
    approvalLevel: 'none',
    requiredAuthority: 'system',
    allowedParameters: {
      target: { type: 'enum', required: false, enum: ['m365', 'teams', 'internet'], description: 'Reachability target class' }
    },
    preconditions: ['device_managed'],
    timeoutSeconds: 30,
    verification: [],
    rollbackOrCompensation: ['none_required_read_only'],
    auditFields: ['actor', 'tenant', 'device', 'evidenceType', 'status'],
    changesDevice: false
  }),
  A({
    actionId: 'inspect_teams_health',
    displayName: 'Check Microsoft Teams',
    kind: 'read_only',
    platform: ['windows'],
    riskTier: 'low',
    approvalLevel: 'none',
    requiredAuthority: 'system',
    allowedParameters: {},
    preconditions: ['device_managed'],
    timeoutSeconds: 30,
    verification: [],
    rollbackOrCompensation: ['none_required_read_only'],
    auditFields: ['actor', 'tenant', 'device', 'evidenceType', 'status'],
    changesDevice: false
  }),
  A({
    actionId: 'collect_support_bundle',
    displayName: 'Collect a diagnostic bundle',
    kind: 'read_only',
    platform: ['windows'],
    riskTier: 'low',
    approvalLevel: 'none',
    requiredAuthority: 'system',
    allowedParameters: {},
    preconditions: ['device_managed'],
    timeoutSeconds: 60,
    verification: [],
    rollbackOrCompensation: ['none_required_read_only'],
    auditFields: ['actor', 'tenant', 'device', 'evidenceType', 'status', 'bundleId'],
    changesDevice: false
  }),

  // -------------------- LOW-RISK REMEDIATION --------------------
  A({
    actionId: 'restart_teams',
    displayName: 'Restart Microsoft Teams',
    kind: 'write',
    platform: ['windows'],
    riskTier: 'low',
    approvalLevel: 'employee',
    requiredAuthority: 'employee',
    allowedParameters: {},
    preconditions: ['device_online', 'device_managed', 'process_present:Teams'],
    timeoutSeconds: 60,
    verification: ['teams_process_running', 'teams_stable_10s'],
    rollbackOrCompensation: ['none_teams_can_be_relaunched_by_user'],
    auditFields: ['actor', 'tenant', 'device', 'actionId', 'result', 'verification'],
    changesDevice: true
  }),
  A({
    actionId: 'clear_teams_cache',
    displayName: 'Clear the Microsoft Teams cache',
    kind: 'write',
    platform: ['windows'],
    riskTier: 'low',
    approvalLevel: 'employee',
    requiredAuthority: 'employee',
    allowedParameters: {},
    preconditions: ['device_online', 'device_managed'],
    timeoutSeconds: 120,
    verification: ['teams_process_running', 'teams_cache_rebuilt', 'teams_stable_10s'],
    rollbackOrCompensation: ['cache_regenerates_on_next_launch'],
    auditFields: ['actor', 'tenant', 'device', 'actionId', 'result', 'verification'],
    changesDevice: true
  }),
  A({
    actionId: 'trigger_intune_sync',
    displayName: 'Trigger a management sync',
    kind: 'write',
    platform: ['windows'],
    riskTier: 'low',
    approvalLevel: 'employee',
    requiredAuthority: 'employee',
    allowedParameters: {},
    preconditions: ['device_online', 'device_managed'],
    timeoutSeconds: 90,
    verification: ['intune_sync_acknowledged'],
    rollbackOrCompensation: ['none_sync_is_idempotent'],
    auditFields: ['actor', 'tenant', 'device', 'actionId', 'result', 'verification'],
    changesDevice: true
  }),

  // -------------------- ELEVATED (defined; NOT in the first live pilot) --------------------
  A({
    actionId: 'reset_user_password',
    displayName: 'Reset the user password',
    kind: 'write',
    platform: ['windows'],
    riskTier: 'elevated',
    approvalLevel: 'it_approver',
    requiredAuthority: 'it_approver',
    allowedParameters: {},
    preconditions: ['identity_verified'],
    timeoutSeconds: 60,
    verification: ['password_reset_confirmed'],
    rollbackOrCompensation: ['revoke_temp_password'],
    auditFields: ['actor', 'tenant', 'target', 'actionId', 'result'],
    changesDevice: false
  })
];

const BY_ID = new Map(ACTION_CATALOG.map((a) => [a.actionId, a]));

export function getAction(actionId: string): ActionDefinition | undefined {
  return BY_ID.get(actionId);
}

export function isAllowlistedAction(actionId: string): boolean {
  return BY_ID.has(actionId);
}

export function listActions(): ActionDefinition[] {
  return ACTION_CATALOG;
}

// Defensive invariant: no catalog action may accept a free-form command/script/shell parameter.
const FORBIDDEN_PARAM = /command|script|shell|powershell|cmd|exec|raw|payload/i;
export function assertNoFreeformCommandParams(): void {
  for (const a of ACTION_CATALOG) {
    for (const p of Object.keys(a.allowedParameters)) {
      if (FORBIDDEN_PARAM.test(p)) {
        throw new Error(`SAFETY VIOLATION: action ${a.actionId} exposes a free-form command parameter '${p}'`);
      }
    }
  }
}
