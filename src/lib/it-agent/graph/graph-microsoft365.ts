// ============================================================
// Watson — H&R AI IT Agent : Microsoft Graph READ-ONLY connector
// ------------------------------------------------------------
// A real, async, READ-ONLY Microsoft Graph connector that returns
// the SAME normalized result shapes as the existing synchronous
// mock connector (wrapped with an explicit fail-soft state).
//
// HARD RULES enforced here:
//   * Read-only. Only HTTP GET + a client-credentials token are used.
//     There are NO write verbs anywhere in this module.
//   * Disabled by default. createGraphConnector() FAILS CLOSED unless
//     the explicit live read-only gate is on AND config is complete.
//   * The mock connector remains the DEFAULT (see getM365ReadOnlyConnector).
//   * No secrets/tokens are ever logged or written to the audit trail.
//   * Missing/limited Graph data returns 'unknown'/'unavailable' — never a
//     fabricated success.
// ============================================================
import type { Actor } from '../types';
import { writeAudit } from '../audit';
import type { GraphConfig, GraphHttpClient } from './graph-config';
import { loadGraphConfig } from './graph-config';
import { mockM365 } from '../mock-microsoft365';

export type ReadState = 'ok' | 'not_found' | 'unknown' | 'unavailable';

export interface ReadResult<T> {
  source: 'mock' | 'graph';
  state: ReadState;
  data: T | null;
  note?: string;
}

export interface NormalizedGraphUser {
  id: string;
  email: string;
  displayName: string;
  jobTitle: string | null;
  department: string | null;
  accountEnabled: boolean | null;
}

export interface LicenseResult { email: string; licenses: string[] }
export interface MfaResult { email: string; mfaEnabled: boolean; mfaMethods: string[] }
export interface MailboxResult { email: string; mailboxType: string | null; mailboxSizeGb: number | null; mailboxQuotaGb: number | null }
export interface GroupResult { email: string; groups: string[] }

// Shared async read-only interface. The same normalized shapes as the existing
// sync M365Connector read methods, returned as Promises with a fail-soft state.
export interface M365ReadOnlyConnector {
  readonly id: string;
  readonly mode: 'mock' | 'live_readonly';
  lookupUser(email: string, actor: Actor): Promise<ReadResult<NormalizedGraphUser>>;
  checkLicenseStatus(email: string, actor: Actor): Promise<ReadResult<LicenseResult>>;
  checkMfaStatus(email: string, actor: Actor): Promise<ReadResult<MfaResult>>;
  checkMailboxStatus(email: string, actor: Actor): Promise<ReadResult<MailboxResult>>;
  checkGroupMembership(email: string, actor: Actor): Promise<ReadResult<GroupResult>>;
}

// ------------------------------------------------------------
// Audit helper — records an ATTEMPTED live read. NEVER logs tokens/secrets.
// ------------------------------------------------------------
function auditLiveRead(actor: Actor, op: string, target: string, meta: Record<string, unknown>) {
  writeAudit({
    actorType: actor.type,
    actorId: actor.id,
    action: 'connector_live_read_attempted',
    targetType: 'microsoft365',
    targetId: target,
    // metadata intentionally excludes any token/secret material
    metadata: { connector: 'ms-graph', op, mode: 'live_readonly', readOnly: true, ...meta }
  });
}

type GraphCollection = { value?: unknown[] };

// ------------------------------------------------------------
// Real Microsoft Graph read-only connector.
// FAILS CLOSED: throws unless the gate is on AND config is complete.
// ------------------------------------------------------------
export function createGraphConnector(config: GraphConfig, http: GraphHttpClient): M365ReadOnlyConnector {
  if (!config.liveReadOnlyEnabled) {
    throw new Error('MsGraphConnector blocked: live read-only gate (IT_AGENT_GRAPH_LIVE_READONLY) is disabled.');
  }
  if (!config.tenantId || !config.clientId || !config.clientSecretRef) {
    throw new Error('MsGraphConnector blocked: required Graph config (tenantId, clientId, clientSecretRef) is incomplete.');
  }

  let cachedToken: string | null = null;
  async function token(): Promise<string> {
    if (cachedToken) return cachedToken;
    cachedToken = await http.getToken();
    return cachedToken;
  }

  async function getJson(path: string): Promise<{ status: number; body: unknown }> {
    const t = await token();
    return http.get(path, t);
  }

  const enc = (s: string) => encodeURIComponent(s.trim());

  return {
    id: 'ms-graph-readonly',
    mode: 'live_readonly',

    async lookupUser(email, actor) {
      auditLiveRead(actor, 'lookupUser', email, { endpoint: '/users/{id}' });
      try {
        const r = await getJson(`/users/${enc(email)}?$select=id,displayName,userPrincipalName,mail,jobTitle,department,accountEnabled`);
        if (r.status === 404) return { source: 'graph', state: 'not_found', data: null };
        if (r.status !== 200 || !r.body || typeof r.body !== 'object') {
          return { source: 'graph', state: 'unavailable', data: null, note: `Graph returned HTTP ${r.status}` };
        }
        const u = r.body as Record<string, unknown>;
        const data: NormalizedGraphUser = {
          id: String(u.id ?? ''),
          email: String(u.mail ?? u.userPrincipalName ?? email),
          displayName: String(u.displayName ?? ''),
          jobTitle: (u.jobTitle as string) ?? null,
          department: (u.department as string) ?? null,
          accountEnabled: typeof u.accountEnabled === 'boolean' ? u.accountEnabled : null
        };
        return { source: 'graph', state: 'ok', data };
      } catch {
        return { source: 'graph', state: 'unavailable', data: null, note: 'Graph request failed' };
      }
    },

    async checkLicenseStatus(email, actor) {
      auditLiveRead(actor, 'checkLicenseStatus', email, { endpoint: '/users/{id}/licenseDetails' });
      try {
        const r = await getJson(`/users/${enc(email)}/licenseDetails?$select=skuPartNumber`);
        if (r.status === 404) return { source: 'graph', state: 'not_found', data: null };
        if (r.status !== 200) return { source: 'graph', state: 'unavailable', data: null, note: `Graph returned HTTP ${r.status}` };
        const coll = (r.body as GraphCollection)?.value ?? [];
        const licenses = coll
          .map((x) => (x as Record<string, unknown>)?.skuPartNumber)
          .filter((x): x is string => typeof x === 'string');
        return { source: 'graph', state: 'ok', data: { email, licenses } };
      } catch {
        return { source: 'graph', state: 'unavailable', data: null, note: 'Graph request failed' };
      }
    },

    async checkMfaStatus(email, actor) {
      auditLiveRead(actor, 'checkMfaStatus', email, { endpoint: '/users/{id}/authentication/methods' });
      try {
        const r = await getJson(`/users/${enc(email)}/authentication/methods`);
        if (r.status === 404) return { source: 'graph', state: 'not_found', data: null };
        // 401/403 typically => missing UserAuthenticationMethod.Read.All or licensing limits.
        if (r.status === 401 || r.status === 403) {
          return { source: 'graph', state: 'unavailable', data: null, note: 'MFA read not permitted (needs UserAuthenticationMethod.Read.All / Entra ID licensing).' };
        }
        if (r.status !== 200) return { source: 'graph', state: 'unknown', data: null, note: `Graph returned HTTP ${r.status}` };
        const methods = ((r.body as GraphCollection)?.value ?? []).map((m) => String((m as Record<string, unknown>)['@odata.type'] ?? ''));
        const strong = methods.filter((t) => t && !/passwordAuthenticationMethod/i.test(t));
        const friendly = strong.map((t) => t.replace('#microsoft.graph.', '').replace('AuthenticationMethod', ''));
        return { source: 'graph', state: 'ok', data: { email, mfaEnabled: strong.length > 0, mfaMethods: friendly } };
      } catch {
        return { source: 'graph', state: 'unavailable', data: null, note: 'Graph request failed' };
      }
    },

    async checkMailboxStatus(email, actor) {
      auditLiveRead(actor, 'checkMailboxStatus', email, { endpoint: '/users/{id}/mailboxSettings' });
      try {
        const r = await getJson(`/users/${enc(email)}/mailboxSettings`);
        if (r.status === 404) return { source: 'graph', state: 'not_found', data: null };
        if (r.status === 401 || r.status === 403) {
          return { source: 'graph', state: 'unavailable', data: null, note: 'Mailbox read not permitted (needs MailboxSettings.Read).' };
        }
        // Mailbox SIZE and QUOTA are NOT available via Microsoft Graph read-only
        // (they require Exchange Online reporting/PowerShell). Return fail-soft
        // 'unavailable' for those fields rather than fabricating numbers.
        const exists = r.status === 200;
        return {
          source: 'graph',
          state: 'unavailable',
          data: { email, mailboxType: exists ? 'user' : null, mailboxSizeGb: null, mailboxQuotaGb: null },
          note: 'Mailbox size/quota are not available via read-only Graph; Exchange Online reporting required.'
        };
      } catch {
        return { source: 'graph', state: 'unavailable', data: null, note: 'Graph request failed' };
      }
    },

    async checkGroupMembership(email, actor) {
      auditLiveRead(actor, 'checkGroupMembership', email, { endpoint: '/users/{id}/transitiveMemberOf' });
      try {
        const r = await getJson(`/users/${enc(email)}/transitiveMemberOf/microsoft.graph.group?$select=displayName`);
        if (r.status === 404) return { source: 'graph', state: 'not_found', data: null };
        if (r.status !== 200) return { source: 'graph', state: 'unavailable', data: null, note: `Graph returned HTTP ${r.status}` };
        const groups = ((r.body as GraphCollection)?.value ?? [])
          .map((g) => (g as Record<string, unknown>)?.displayName)
          .filter((x): x is string => typeof x === 'string');
        return { source: 'graph', state: 'ok', data: { email, groups } };
      } catch {
        return { source: 'graph', state: 'unavailable', data: null, note: 'Graph request failed' };
      }
    }
  };
}

// ------------------------------------------------------------
// Async READ-ONLY adapter over the existing synchronous mock connector.
// Lets the same async interface return mock data (the DEFAULT path).
// ------------------------------------------------------------
export const mockReadOnlyConnector: M365ReadOnlyConnector = {
  id: 'mock-microsoft365-readonly',
  mode: 'mock',

  async lookupUser(email, actor) {
    const u = mockM365.lookupUser(email, actor);
    if (!u) return { source: 'mock', state: 'not_found', data: null };
    return {
      source: 'mock',
      state: 'ok',
      data: { id: u.id, email: u.email, displayName: u.displayName, jobTitle: u.jobTitle, department: u.department, accountEnabled: u.accountEnabled }
    };
  },
  async checkLicenseStatus(email, actor) {
    const r = mockM365.checkLicenseStatus(email, actor);
    return r ? { source: 'mock', state: 'ok', data: r } : { source: 'mock', state: 'not_found', data: null };
  },
  async checkMfaStatus(email, actor) {
    const r = mockM365.checkMfaStatus(email, actor);
    return r ? { source: 'mock', state: 'ok', data: r } : { source: 'mock', state: 'not_found', data: null };
  },
  async checkMailboxStatus(email, actor) {
    const r = mockM365.checkMailboxStatus(email, actor);
    return r
      ? { source: 'mock', state: 'ok', data: { email: r.email, mailboxType: r.mailboxType, mailboxSizeGb: r.mailboxSizeGb, mailboxQuotaGb: r.mailboxQuotaGb } }
      : { source: 'mock', state: 'not_found', data: null };
  },
  async checkGroupMembership(email, actor) {
    const r = mockM365.checkGroupMembership(email, actor);
    return r ? { source: 'mock', state: 'ok', data: r } : { source: 'mock', state: 'not_found', data: null };
  }
};

// ------------------------------------------------------------
// Provider selection. DEFAULT = mock. Returns the live Graph connector ONLY
// when the gate is enabled AND config is complete AND an HTTP client is
// supplied (in production the bootstrap resolves the Key Vault secret and
// builds the real client; tests inject a fake client). Fails closed to mock.
// ------------------------------------------------------------
export function getM365ReadOnlyConnector(opts: { env?: NodeJS.ProcessEnv; http?: GraphHttpClient } = {}): M365ReadOnlyConnector {
  const env = opts.env ?? process.env;
  const config = loadGraphConfig(env);
  if (config && config.liveReadOnlyEnabled && opts.http) {
    return createGraphConnector(config, opts.http);
  }
  return mockReadOnlyConnector;
}

export function readonlyConnectorStatus(env: NodeJS.ProcessEnv = process.env) {
  const config = loadGraphConfig(env);
  const active = getM365ReadOnlyConnector({ env });
  return {
    activeConnectorId: active.id,
    activeMode: active.mode, // 'mock' by default
    graphConfigured: Boolean(config),
    graphLiveReadOnlyEnabled: Boolean(config?.liveReadOnlyEnabled),
    note: 'Mock is the default read-only connector. Live Graph requires IT_AGENT_GRAPH_LIVE_READONLY=true, complete config, Key Vault secret, and an injected HTTP client. No write scopes anywhere.'
  };
}
