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
import { loadGraphConfig, isSameGraphOrigin } from './graph-config';
import { mockM365 } from '../mock-microsoft365';

// ------------------------------------------------------------
// Resilience / correctness bounds for the live read path. All GETs here are
// idempotent reads, so bounded retry of transient failures is safe.
// ------------------------------------------------------------
const MAX_RETRIES = 3;            // total attempts = 1 + MAX_RETRIES
const BASE_BACKOFF_MS = 250;      // exponential base for backoff
const MAX_BACKOFF_MS = 8_000;     // ceiling for any single wait
const MAX_RETRY_AFTER_MS = 30_000; // never honor a server Retry-After beyond this
const MAX_PAGES = 50;             // hard ceiling on @odata.nextLink following

// Weak factors that must NOT be counted as multi-factor authentication:
// a password is the first factor, and email OTP is an account-recovery (SSPR)
// channel rather than a valid second factor in most tenants.
const WEAK_AUTH_METHOD = /passwordAuthenticationMethod|emailAuthenticationMethod/i;

// Injectable timing seams so retry/backoff is fully deterministic under test
// (tests pass a no-op sleep and a fixed rng); production uses real timers.
export interface GraphConnectorDeps {
  sleep?: (ms: number) => Promise<void>;
  rng?: () => number;
}
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
export function createGraphConnector(config: GraphConfig, http: GraphHttpClient, deps: GraphConnectorDeps = {}): M365ReadOnlyConnector {
  if (!config.liveReadOnlyEnabled) {
    throw new Error('MsGraphConnector blocked: live read-only gate (IT_AGENT_GRAPH_LIVE_READONLY) is disabled.');
  }
  // Under managed identity the platform supplies the credential, so tenant id,
  // client id, and a secret reference are meaningless — requiring them would be
  // a false check. The credential itself is validated upstream (token acquired
  // AND required app roles present) before this connector is ever constructed.
  if (config.credentialModel !== 'managed_identity') {
    if (!config.tenantId || !config.clientId || !config.clientSecretRef) {
      throw new Error('MsGraphConnector blocked: required Graph config (tenantId, clientId, clientSecretRef) is incomplete.');
    }
  }

  const sleep = deps.sleep ?? realSleep;
  const rng = deps.rng ?? Math.random;

  let cachedToken: string | null = null;
  async function token(): Promise<string> {
    if (cachedToken) return cachedToken;
    cachedToken = await http.getToken();
    return cachedToken;
  }

  // Compute the wait before the next retry. Honors a server Retry-After when
  // present (bounded), otherwise exponential backoff with full jitter. Never
  // unbounded — protects against retry storms.
  function backoffMs(attempt: number, retryAfterSeconds?: number): number {
    if (typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds)) {
      return Math.min(Math.max(0, retryAfterSeconds) * 1000, MAX_RETRY_AFTER_MS);
    }
    const ceiling = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
    return Math.floor(rng() * ceiling); // full jitter in [0, ceiling)
  }

  // A single Graph GET with bounded retry. Retries ONLY transient, retry-safe
  // statuses (429 and 5xx). Permanent outcomes — 401/403 (authz), 404, other
  // 4xx — are returned immediately and never retried (no retry storms on
  // permanent authorization/configuration failures). Network errors on an
  // idempotent read are likewise retried up to the cap.
  async function getJson(path: string): Promise<{ status: number; body: unknown; retryAfterSeconds?: number }> {
    let attempt = 0;
    for (;;) {
      let res: { status: number; body: unknown; retryAfterSeconds?: number };
      try {
        const t = await token();
        res = await http.get(path, t);
      } catch (err) {
        if (attempt >= MAX_RETRIES) throw err;
        await sleep(backoffMs(attempt));
        attempt++;
        continue;
      }
      const transient = res.status === 429 || res.status >= 500;
      if (transient && attempt < MAX_RETRIES) {
        await sleep(backoffMs(attempt, res.retryAfterSeconds));
        attempt++;
        continue;
      }
      return res;
    }
  }

  // Read a Graph collection, following @odata.nextLink across pages. Each
  // nextLink is verified to target the SAME Graph origin before it is fetched,
  // so a tampered response cannot redirect reads (or the token) to a foreign
  // host. Bounded by MAX_PAGES. The returned status is the first page's status
  // so callers can distinguish 404/401/403/other from success.
  async function getCollection(path: string): Promise<{ status: number; values: unknown[] }> {
    const first = await getJson(path);
    if (first.status !== 200 || !first.body || typeof first.body !== 'object') {
      return { status: first.status, values: [] };
    }
    const values: unknown[] = [];
    let body = first.body as GraphCollection & { '@odata.nextLink'?: unknown };
    let pages = 0;
    for (;;) {
      if (Array.isArray(body.value)) values.push(...body.value);
      pages++;
      const next = body['@odata.nextLink'];
      if (typeof next !== 'string' || pages >= MAX_PAGES) break;
      if (!isSameGraphOrigin(next, config.graphBaseUrl)) break; // refuse foreign host
      const page = await getJson(next);
      if (page.status !== 200 || !page.body || typeof page.body !== 'object') break;
      body = page.body as GraphCollection & { '@odata.nextLink'?: unknown };
    }
    return { status: 200, values };
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
        const r = await getCollection(`/users/${enc(email)}/licenseDetails?$select=skuPartNumber`);
        if (r.status === 404) return { source: 'graph', state: 'not_found', data: null };
        if (r.status !== 200) return { source: 'graph', state: 'unavailable', data: null, note: `Graph returned HTTP ${r.status}` };
        const licenses = r.values
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
        const r = await getCollection(`/users/${enc(email)}/authentication/methods`);
        if (r.status === 404) return { source: 'graph', state: 'not_found', data: null };
        // 401/403 typically => missing UserAuthenticationMethod.Read.All or licensing limits.
        if (r.status === 401 || r.status === 403) {
          return { source: 'graph', state: 'unavailable', data: null, note: 'MFA read not permitted (needs UserAuthenticationMethod.Read.All / Entra ID licensing).' };
        }
        if (r.status !== 200) return { source: 'graph', state: 'unknown', data: null, note: `Graph returned HTTP ${r.status}` };
        const methods = r.values.map((m) => String((m as Record<string, unknown>)['@odata.type'] ?? ''));
        // Registered STRONG factors only: exclude password (first factor) and
        // email OTP (recovery channel). NOTE: the presence of a registered
        // strong method proves capability, NOT that MFA is enforced by policy
        // (Conditional Access / per-user enforcement state is not readable here).
        const strong = methods.filter((t) => t && !WEAK_AUTH_METHOD.test(t));
        const friendly = strong.map((t) => t.replace('#microsoft.graph.', '').replace('AuthenticationMethod', ''));
        return {
          source: 'graph',
          state: 'ok',
          data: { email, mfaEnabled: strong.length > 0, mfaMethods: friendly },
          note: 'Reflects registered strong authentication methods, not enforced MFA policy.'
        };
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
        const r = await getCollection(`/users/${enc(email)}/transitiveMemberOf/microsoft.graph.group?$select=displayName`);
        if (r.status === 404) return { source: 'graph', state: 'not_found', data: null };
        if (r.status !== 200) return { source: 'graph', state: 'unavailable', data: null, note: `Graph returned HTTP ${r.status}` };
        const groups = r.values
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
