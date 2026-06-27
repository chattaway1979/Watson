// ============================================================
// Watson — H&R AI IT Agent : Agent Action Registry
// ------------------------------------------------------------
// Single source of truth for every IT action Watson knows about.
// Risk level, required role, approval requirement, connector
// target, exec mode, and I/O schemas live here. The policy and
// approval engines READ from this registry — they never bypass it.
// liveExecutable is hard-coded false for EVERY action in this build.
// ============================================================
import type { ActionDefinition } from './types';

const A = (d: ActionDefinition): ActionDefinition => ({ ...d, liveExecutable: false });

export const ACTION_REGISTRY: ActionDefinition[] = [
  // -------- Low risk (safe, may run automatically) --------
  A({
    key: 'search_knowledge_base',
    displayName: 'Search Knowledge Base',
    category: 'knowledge',
    description: 'Search seeded H&R IT knowledge articles by keyword/category.',
    riskLevel: 'low',
    requiredRole: 'employee',
    requiresApproval: false,
    mockExecutable: true,
    liveExecutable: false,
    execMode: 'read_only',
    connectorTarget: 'knowledge_base',
    inputSchema: { query: 'string', category: 'string?' },
    resultSchema: { articles: 'KnowledgeArticle[]' },
    auditBehavior: 'No audit (read-only browse).'
  }),
  A({
    key: 'create_ticket',
    displayName: 'Create Ticket',
    category: 'ticketing',
    description: 'Create a new IT support ticket for the requester.',
    riskLevel: 'low',
    requiredRole: 'employee',
    requiresApproval: false,
    mockExecutable: true,
    liveExecutable: false,
    execMode: 'preparatory',
    connectorTarget: 'ticketing',
    inputSchema: { subject: 'string', description: 'string', category: 'TicketCategory' },
    resultSchema: { ticketId: 'string', shortId: 'string' },
    auditBehavior: 'Writes ticket_created.'
  }),
  A({
    key: 'add_ticket_note',
    displayName: 'Add Ticket Note',
    category: 'ticketing',
    description: 'Append a message or internal note to a ticket.',
    riskLevel: 'low',
    requiredRole: 'employee',
    requiresApproval: false,
    mockExecutable: true,
    liveExecutable: false,
    execMode: 'preparatory',
    connectorTarget: 'ticketing',
    inputSchema: { ticketId: 'string', body: 'string', internal: 'boolean' },
    resultSchema: { messageId: 'string' },
    auditBehavior: 'Writes admin_note_added or ai_message_created.'
  }),
  A({
    key: 'send_setup_instructions',
    displayName: 'Send Setup Instructions',
    category: 'knowledge',
    description: 'Surface a step-by-step setup article to the employee.',
    riskLevel: 'low',
    requiredRole: 'employee',
    requiresApproval: false,
    mockExecutable: true,
    liveExecutable: false,
    execMode: 'read_only',
    connectorTarget: 'knowledge_base',
    inputSchema: { slug: 'string' },
    resultSchema: { article: 'KnowledgeArticle' },
    auditBehavior: 'No audit (read-only).'
  }),
  A({
    key: 'escalate_ticket',
    displayName: 'Escalate Ticket',
    category: 'ticketing',
    description: 'Escalate a ticket to admin queue and raise priority.',
    riskLevel: 'low',
    requiredRole: 'employee',
    requiresApproval: false,
    mockExecutable: true,
    liveExecutable: false,
    execMode: 'preparatory',
    connectorTarget: 'ticketing',
    inputSchema: { ticketId: 'string', reason: 'string' },
    resultSchema: { ticketId: 'string', status: 'string' },
    auditBehavior: 'Writes ticket_status_changed.'
  }),

  // -------- Medium risk (admin/manager; mock lookups) --------
  A({
    key: 'lookup_user',
    displayName: 'Lookup M365 User',
    category: 'microsoft365',
    description: 'Look up a Microsoft 365 user profile (MOCK data).',
    riskLevel: 'medium',
    requiredRole: 'admin',
    requiresApproval: false,
    mockExecutable: true,
    liveExecutable: false,
    execMode: 'read_only',
    connectorTarget: 'microsoft365',
    inputSchema: { email: 'string' },
    resultSchema: { user: 'MockM365User' },
    auditBehavior: 'Writes connector_mock_called.'
  }),
  A({
    key: 'check_license_status',
    displayName: 'Check License Status',
    category: 'microsoft365',
    description: 'Check assigned M365 licenses for a user (MOCK).',
    riskLevel: 'medium',
    requiredRole: 'admin',
    requiresApproval: false,
    mockExecutable: true,
    liveExecutable: false,
    execMode: 'read_only',
    connectorTarget: 'microsoft365',
    inputSchema: { email: 'string' },
    resultSchema: { licenses: 'string[]' },
    auditBehavior: 'Writes connector_mock_called.'
  }),
  A({
    key: 'check_mfa_status',
    displayName: 'Check MFA Status',
    category: 'microsoft365',
    description: 'Check MFA enrollment + methods for a user (MOCK).',
    riskLevel: 'medium',
    requiredRole: 'admin',
    requiresApproval: false,
    mockExecutable: true,
    liveExecutable: false,
    execMode: 'read_only',
    connectorTarget: 'microsoft365',
    inputSchema: { email: 'string' },
    resultSchema: { mfaEnabled: 'boolean', mfaMethods: 'string[]' },
    auditBehavior: 'Writes connector_mock_called.'
  }),
  A({
    key: 'check_mailbox_status',
    displayName: 'Check Mailbox Status',
    category: 'microsoft365',
    description: 'Check mailbox type, size and quota (MOCK).',
    riskLevel: 'medium',
    requiredRole: 'admin',
    requiresApproval: false,
    mockExecutable: true,
    liveExecutable: false,
    execMode: 'read_only',
    connectorTarget: 'microsoft365',
    inputSchema: { email: 'string' },
    resultSchema: { mailboxType: 'string', mailboxSizeGb: 'number', mailboxQuotaGb: 'number' },
    auditBehavior: 'Writes connector_mock_called.'
  }),
  A({
    key: 'check_group_membership',
    displayName: 'Check Group Membership',
    category: 'microsoft365',
    description: 'List security/distribution groups for a user (MOCK).',
    riskLevel: 'medium',
    requiredRole: 'admin',
    requiresApproval: false,
    mockExecutable: true,
    liveExecutable: false,
    execMode: 'read_only',
    connectorTarget: 'microsoft365',
    inputSchema: { email: 'string' },
    resultSchema: { groups: 'string[]' },
    auditBehavior: 'Writes connector_mock_called.'
  }),
  A({
    key: 'lookup_device',
    displayName: 'Lookup Device',
    category: 'device_rmm',
    description: 'Find a managed device by user email (MOCK RMM).',
    riskLevel: 'medium',
    requiredRole: 'admin',
    requiresApproval: false,
    mockExecutable: true,
    liveExecutable: false,
    execMode: 'read_only',
    connectorTarget: 'device_rmm',
    inputSchema: { email: 'string' },
    resultSchema: { device: 'MockDevice' },
    auditBehavior: 'Writes connector_mock_called.'
  }),
  A({
    key: 'check_device_status',
    displayName: 'Check Device Status',
    category: 'device_rmm',
    description: 'Disk, patch, AV, compliance & check-in status (MOCK).',
    riskLevel: 'medium',
    requiredRole: 'admin',
    requiresApproval: false,
    mockExecutable: true,
    liveExecutable: false,
    execMode: 'read_only',
    connectorTarget: 'device_rmm',
    inputSchema: { deviceId: 'string' },
    resultSchema: { status: 'object' },
    auditBehavior: 'Writes connector_mock_called.'
  }),
  A({
    key: 'trigger_device_sync_mock',
    displayName: 'Trigger Device Sync (Mock)',
    category: 'device_rmm',
    description: 'Simulate an RMM/Intune device policy sync.',
    riskLevel: 'medium',
    requiredRole: 'admin',
    requiresApproval: false,
    mockExecutable: true,
    liveExecutable: false,
    execMode: 'mock_executable',
    connectorTarget: 'device_rmm',
    inputSchema: { deviceId: 'string' },
    resultSchema: { syncQueued: 'boolean', simulatedAt: 'string' },
    auditBehavior: 'Writes mock_action_executed.'
  }),
  A({
    key: 'collect_device_diagnostics_mock',
    displayName: 'Collect Device Diagnostics (Mock)',
    category: 'device_rmm',
    description: 'Simulate collecting diagnostics bundle from a device.',
    riskLevel: 'medium',
    requiredRole: 'admin',
    requiresApproval: false,
    mockExecutable: true,
    liveExecutable: false,
    execMode: 'mock_executable',
    connectorTarget: 'device_rmm',
    inputSchema: { deviceId: 'string' },
    resultSchema: { bundleId: 'string', items: 'string[]' },
    auditBehavior: 'Writes mock_action_executed.'
  }),

  // -------- High risk (require approval) --------
  A({
    key: 'prepare_password_reset',
    displayName: 'Prepare Password Reset',
    category: 'microsoft365',
    description: 'Prepare (NOT execute) a password reset request for approval.',
    riskLevel: 'high',
    requiredRole: 'admin',
    requiresApproval: true,
    mockExecutable: true,
    liveExecutable: false,
    execMode: 'preparatory',
    connectorTarget: 'microsoft365',
    inputSchema: { email: 'string', reason: 'string' },
    resultSchema: { prepared: 'boolean', approvalId: 'string' },
    auditBehavior: 'Writes approval_requested; execution simulated only on approval.'
  }),
  A({
    key: 'prepare_mfa_reset',
    displayName: 'Prepare MFA Reset',
    category: 'microsoft365',
    description: 'Prepare (NOT execute) an MFA reset request for approval.',
    riskLevel: 'high',
    requiredRole: 'admin',
    requiresApproval: true,
    mockExecutable: true,
    liveExecutable: false,
    execMode: 'preparatory',
    connectorTarget: 'microsoft365',
    inputSchema: { email: 'string', reason: 'string' },
    resultSchema: { prepared: 'boolean', approvalId: 'string' },
    auditBehavior: 'Writes approval_requested.'
  }),
  A({
    key: 'prepare_new_user',
    displayName: 'Prepare New User',
    category: 'microsoft365',
    description: 'Prepare a new-user creation packet for onboarding approval.',
    riskLevel: 'high',
    requiredRole: 'manager',
    requiresApproval: true,
    mockExecutable: true,
    liveExecutable: false,
    execMode: 'preparatory',
    connectorTarget: 'microsoft365',
    inputSchema: { displayName: 'string', jobTitle: 'string', startDate: 'string', manager: 'string' },
    resultSchema: { prepared: 'boolean', approvalId: 'string' },
    auditBehavior: 'Writes approval_requested.'
  }),
  A({
    key: 'prepare_license_assignment',
    displayName: 'Prepare License Assignment',
    category: 'microsoft365',
    description: 'Prepare an M365 license assignment request for approval.',
    riskLevel: 'high',
    requiredRole: 'admin',
    requiresApproval: true,
    mockExecutable: true,
    liveExecutable: false,
    execMode: 'preparatory',
    connectorTarget: 'microsoft365',
    inputSchema: { email: 'string', sku: 'string' },
    resultSchema: { prepared: 'boolean', approvalId: 'string' },
    auditBehavior: 'Writes approval_requested.'
  }),
  A({
    key: 'prepare_shared_mailbox_access',
    displayName: 'Prepare Shared Mailbox Access',
    category: 'microsoft365',
    description: 'Prepare a shared mailbox access grant for approval.',
    riskLevel: 'high',
    requiredRole: 'admin',
    requiresApproval: true,
    mockExecutable: true,
    liveExecutable: false,
    execMode: 'preparatory',
    connectorTarget: 'microsoft365',
    inputSchema: { mailbox: 'string', grantee: 'string', accessLevel: 'string' },
    resultSchema: { prepared: 'boolean', approvalId: 'string' },
    auditBehavior: 'Writes approval_requested.'
  }),
  A({
    key: 'prepare_remote_support_session',
    displayName: 'Prepare Remote Support Session',
    category: 'device_rmm',
    description: 'Prepare a remote support session request for approval.',
    riskLevel: 'high',
    requiredRole: 'admin',
    requiresApproval: true,
    mockExecutable: true,
    liveExecutable: false,
    execMode: 'preparatory',
    connectorTarget: 'device_rmm',
    inputSchema: { deviceId: 'string', reason: 'string' },
    resultSchema: { prepared: 'boolean', approvalId: 'string' },
    auditBehavior: 'Writes approval_requested.'
  }),
  A({
    key: 'prepare_software_install',
    displayName: 'Prepare Software Install',
    category: 'device_rmm',
    description: 'Prepare an approved-software install request for approval.',
    riskLevel: 'high',
    requiredRole: 'admin',
    requiresApproval: true,
    mockExecutable: true,
    liveExecutable: false,
    execMode: 'preparatory',
    connectorTarget: 'device_rmm',
    inputSchema: { deviceId: 'string', software: 'string' },
    resultSchema: { prepared: 'boolean', approvalId: 'string' },
    auditBehavior: 'Writes approval_requested.'
  }),

  // -------- Onboarding / Offboarding prep (require approval) --------
  A({
    key: 'prepare_onboarding_checklist',
    displayName: 'Prepare Onboarding Checklist',
    category: 'lifecycle',
    description: 'Assemble an onboarding checklist & account/license/device requests.',
    riskLevel: 'high',
    requiredRole: 'manager',
    requiresApproval: true,
    mockExecutable: true,
    liveExecutable: false,
    execMode: 'preparatory',
    connectorTarget: 'internal',
    inputSchema: { employeeName: 'string', role: 'string', startDate: 'string', manager: 'string' },
    resultSchema: { checklist: 'string[]', approvalId: 'string' },
    auditBehavior: 'Writes approval_requested.'
  }),
  A({
    key: 'prepare_offboarding_checklist',
    displayName: 'Prepare Offboarding Checklist',
    category: 'lifecycle',
    description: 'Assemble an offboarding checklist & access-shutdown requests.',
    riskLevel: 'critical',
    requiredRole: 'manager',
    requiresApproval: true,
    mockExecutable: true,
    liveExecutable: false,
    execMode: 'preparatory',
    connectorTarget: 'internal',
    inputSchema: { employeeName: 'string', terminationDate: 'string', manager: 'string', urgency: 'string' },
    resultSchema: { checklist: 'string[]', approvalId: 'string' },
    auditBehavior: 'Writes approval_requested; never disables accounts in this build.'
  }),

  // -------- Critical (owner/admin approval; live ALWAYS disabled) --------
  A({
    key: 'disable_account',
    displayName: 'Disable Account',
    category: 'microsoft365',
    description: 'CRITICAL: disable a user account. Live execution disabled.',
    riskLevel: 'critical',
    requiredRole: 'owner',
    requiresApproval: true,
    mockExecutable: false,
    liveExecutable: false,
    execMode: 'future_live',
    connectorTarget: 'microsoft365',
    inputSchema: { email: 'string', reason: 'string' },
    resultSchema: { wouldDisable: 'boolean' },
    auditBehavior: 'Writes approval_requested. Execution blocked by live gate.'
  }),
  A({
    key: 'delete_user',
    displayName: 'Delete User',
    category: 'microsoft365',
    description: 'CRITICAL: delete a user. Live execution disabled.',
    riskLevel: 'critical',
    requiredRole: 'owner',
    requiresApproval: true,
    mockExecutable: false,
    liveExecutable: false,
    execMode: 'future_live',
    connectorTarget: 'microsoft365',
    inputSchema: { email: 'string', reason: 'string' },
    resultSchema: { wouldDelete: 'boolean' },
    auditBehavior: 'Writes approval_requested. Execution blocked by live gate.'
  }),
  A({
    key: 'wipe_device',
    displayName: 'Wipe Device',
    category: 'device_rmm',
    description: 'CRITICAL: wipe/retire a device. Live execution disabled.',
    riskLevel: 'critical',
    requiredRole: 'owner',
    requiresApproval: true,
    mockExecutable: false,
    liveExecutable: false,
    execMode: 'future_live',
    connectorTarget: 'device_rmm',
    inputSchema: { deviceId: 'string', reason: 'string' },
    resultSchema: { wouldWipe: 'boolean' },
    auditBehavior: 'Writes approval_requested. Execution blocked by live gate.'
  }),
  A({
    key: 'privileged_role_change',
    displayName: 'Privileged Role Change',
    category: 'microsoft365',
    description: 'CRITICAL: change privileged role membership. Live disabled.',
    riskLevel: 'critical',
    requiredRole: 'owner',
    requiresApproval: true,
    mockExecutable: false,
    liveExecutable: false,
    execMode: 'future_live',
    connectorTarget: 'microsoft365',
    inputSchema: { email: 'string', role: 'string', operation: 'string' },
    resultSchema: { wouldChange: 'boolean' },
    auditBehavior: 'Writes approval_requested. Execution blocked by live gate.'
  }),
  A({
    key: 'access_mailbox_content',
    displayName: 'Access Mailbox Content',
    category: 'microsoft365',
    description: 'CRITICAL: access employee mailbox content. Live disabled.',
    riskLevel: 'critical',
    requiredRole: 'owner',
    requiresApproval: true,
    mockExecutable: false,
    liveExecutable: false,
    execMode: 'future_live',
    connectorTarget: 'microsoft365',
    inputSchema: { mailbox: 'string', reason: 'string' },
    resultSchema: { wouldAccess: 'boolean' },
    auditBehavior: 'Writes approval_requested. Execution blocked by live gate.'
  }),
  A({
    key: 'offboarding_access_shutdown',
    displayName: 'Offboarding Access Shutdown',
    category: 'lifecycle',
    description: 'CRITICAL: execute offboarding access shutdown. Live disabled.',
    riskLevel: 'critical',
    requiredRole: 'owner',
    requiresApproval: true,
    mockExecutable: false,
    liveExecutable: false,
    execMode: 'future_live',
    connectorTarget: 'microsoft365',
    inputSchema: { email: 'string', terminationDate: 'string' },
    resultSchema: { wouldShutdown: 'boolean' },
    auditBehavior: 'Writes approval_requested. Execution blocked by live gate.'
  })
];

const BY_KEY = new Map(ACTION_REGISTRY.map((a) => [a.key, a]));

export function getAction(key: string): ActionDefinition | undefined {
  return BY_KEY.get(key);
}

export function listActions(): ActionDefinition[] {
  return ACTION_REGISTRY;
}

// Defensive invariant: in this build NOTHING may be live-executable.
export function assertNoLiveExecutable(): void {
  const offenders = ACTION_REGISTRY.filter((a) => a.liveExecutable);
  if (offenders.length > 0) {
    throw new Error(
      `SAFETY VIOLATION: actions marked liveExecutable: ${offenders.map((o) => o.key).join(', ')}`
    );
  }
}
