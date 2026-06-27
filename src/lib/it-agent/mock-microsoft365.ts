// ============================================================
// Watson — H&R AI IT Agent : MOCK Microsoft 365 Connector
// ------------------------------------------------------------
// Returns deterministic, plausible mock data. NEVER calls a real
// Microsoft Graph / Exchange / Entra endpoint. All "prepare_*"
// operations return a prepared packet only — they execute nothing.
// Future: implement MsGraphConnector with the same interface.
// ============================================================
import { db } from '../store/db';
import { writeAudit } from './audit';
import type { Actor, MockM365User } from './types';

export interface M365Connector {
  readonly id: string;
  readonly mode: 'mock' | 'live';
  lookupUser(email: string, actor: Actor): MockM365User | null;
  checkLicenseStatus(email: string, actor: Actor): { email: string; licenses: string[] } | null;
  checkMfaStatus(email: string, actor: Actor): { email: string; mfaEnabled: boolean; mfaMethods: string[] } | null;
  checkMailboxStatus(email: string, actor: Actor): { email: string; mailboxType: string; mailboxSizeGb: number; mailboxQuotaGb: number } | null;
  checkGroupMembership(email: string, actor: Actor): { email: string; groups: string[] } | null;
  prepareNewUser(input: Record<string, unknown>, actor: Actor): { prepared: true; packet: Record<string, unknown> };
  preparePasswordReset(email: string, actor: Actor): { prepared: true; packet: Record<string, unknown> };
  prepareMfaReset(email: string, actor: Actor): { prepared: true; packet: Record<string, unknown> };
  prepareLicenseAssignment(email: string, sku: string, actor: Actor): { prepared: true; packet: Record<string, unknown> };
  prepareOffboarding(email: string, actor: Actor): { prepared: true; packet: Record<string, unknown> };
}

function audit(actor: Actor, op: string, target: string, meta: Record<string, unknown>) {
  writeAudit({
    actorType: actor.type,
    actorId: actor.id,
    action: 'connector_mock_called',
    targetType: 'microsoft365',
    targetId: target,
    metadata: { connector: 'mock-microsoft365', op, mode: 'mock', ...meta }
  });
}

function find(email: string): MockM365User | null {
  const e = email.trim().toLowerCase();
  return db().mockUsers.find((u) => u.email.toLowerCase() === e) ?? null;
}

export const mockM365: M365Connector = {
  id: 'mock-microsoft365',
  mode: 'mock',

  lookupUser(email, actor) {
    const u = find(email);
    audit(actor, 'lookupUser', email, { found: Boolean(u) });
    return u;
  },
  checkLicenseStatus(email, actor) {
    const u = find(email);
    audit(actor, 'checkLicenseStatus', email, { found: Boolean(u) });
    return u ? { email: u.email, licenses: u.licenses } : null;
  },
  checkMfaStatus(email, actor) {
    const u = find(email);
    audit(actor, 'checkMfaStatus', email, { found: Boolean(u) });
    return u ? { email: u.email, mfaEnabled: u.mfaEnabled, mfaMethods: u.mfaMethods } : null;
  },
  checkMailboxStatus(email, actor) {
    const u = find(email);
    audit(actor, 'checkMailboxStatus', email, { found: Boolean(u) });
    return u
      ? { email: u.email, mailboxType: u.mailboxType, mailboxSizeGb: u.mailboxSizeGb, mailboxQuotaGb: u.mailboxQuotaGb }
      : null;
  },
  checkGroupMembership(email, actor) {
    const u = find(email);
    audit(actor, 'checkGroupMembership', email, { found: Boolean(u) });
    return u ? { email: u.email, groups: u.groups } : null;
  },

  // ---- preparatory only: nothing is executed ----
  prepareNewUser(input, actor) {
    audit(actor, 'prepareNewUser', String(input.displayName ?? 'unknown'), { preparedOnly: true });
    return {
      prepared: true,
      packet: {
        operation: 'create_user',
        note: 'PREPARED ONLY — not executed. Requires approval + live gate (disabled).',
        proposed: input
      }
    };
  },
  preparePasswordReset(email, actor) {
    audit(actor, 'preparePasswordReset', email, { preparedOnly: true });
    return { prepared: true, packet: { operation: 'password_reset', email, note: 'PREPARED ONLY — not executed.' } };
  },
  prepareMfaReset(email, actor) {
    audit(actor, 'prepareMfaReset', email, { preparedOnly: true });
    return { prepared: true, packet: { operation: 'mfa_reset', email, note: 'PREPARED ONLY — not executed.' } };
  },
  prepareLicenseAssignment(email, sku, actor) {
    audit(actor, 'prepareLicenseAssignment', email, { preparedOnly: true, sku });
    return { prepared: true, packet: { operation: 'assign_license', email, sku, note: 'PREPARED ONLY — not executed.' } };
  },
  prepareOffboarding(email, actor) {
    audit(actor, 'prepareOffboarding', email, { preparedOnly: true });
    return {
      prepared: true,
      packet: {
        operation: 'offboarding_prepare',
        email,
        steps: ['Review mailbox delegation', 'Review forwarding rules', 'Plan license removal', 'Plan group removal'],
        note: 'PREPARED ONLY — accounts are NEVER disabled in this build.'
      }
    };
  }
};

export function connectorStatus() {
  return {
    id: mockM365.id,
    label: 'Microsoft 365 (Mock)',
    mode: mockM365.mode,
    healthy: true,
    note: 'Deterministic mock. No real Microsoft Graph/Exchange/Entra calls.',
    futureAdapter: 'MsGraphConnector (read-only first)'
  };
}
