/* ============================================================
 * Watson — H&R AI IT Agent : Graph READ-ONLY connector self-tests
 * Invoked from it-agent-selftest.ts. Uses NO network — a fake
 * GraphHttpClient is injected for every Graph mapping test, and
 * the default/gate paths never construct a real client.
 * ============================================================ */
import { listAudit } from '../src/lib/it-agent/audit';
import { isLiveExternalExecutionEnabled } from '../src/lib/it-agent/constants';
import {
  createGraphConnector,
  getM365ReadOnlyConnector
} from '../src/lib/it-agent/graph/graph-microsoft365';
import {
  loadGraphConfig,
  resolveGraphUrl,
  isSameGraphOrigin,
  parseRetryAfterSeconds
} from '../src/lib/it-agent/graph/graph-config';
import type { GraphConfig, GraphHttpClient } from '../src/lib/it-agent/graph/graph-config';
import type { Actor } from '../src/lib/it-agent/types';

type Resp = { status: number; body: unknown; retryAfterSeconds?: number };

// Deterministic, network-free deps for the connector: no real timers, fixed RNG.
// `sleeps` records requested backoff waits so Retry-After honoring can be asserted.
function testDeps() {
  const sleeps: number[] = [];
  return { sleeps, deps: { sleep: async (ms: number) => { sleeps.push(ms); }, rng: () => 0 } };
}

// A route-driven fake Graph client that records every requested path. A route
// value may be a single response or a sequence (consumed in order) to model
// transient failures. A response with status === -1 makes get() THROW, modeling
// a network error / aborted (timed-out) request.
const THROW: Resp = { status: -1, body: null };
function recordingHttp(routes: Array<[string, Resp | Resp[]]>, token = 'BEARER-TOKEN-SECRET-DO-NOT-LOG') {
  const calls: string[] = [];
  const seq = new Map<string, number>();
  const http: GraphHttpClient = {
    async getToken() { return token; },
    async get(path: string) {
      calls.push(path);
      for (const [k, v] of routes) {
        if (path.includes(k)) {
          const chosen = Array.isArray(v) ? v[Math.min(seq.get(k) ?? 0, v.length - 1)] : v;
          if (Array.isArray(v)) seq.set(k, (seq.get(k) ?? 0) + 1);
          if (chosen.status === -1) throw new Error('simulated network/timeout abort');
          return chosen;
        }
      }
      return { status: 500, body: null };
    }
  };
  return { http, calls };
}

export async function runGraphReadOnlyTests(): Promise<{ pass: number; fail: number; failures: string[] }> {
  let pass = 0;
  let fail = 0;
  const failures: string[] = [];
  const check = (name: string, cond: boolean, detail = '') => {
    if (cond) { pass++; console.log('  ✅ ' + name); }
    else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log('  ❌ ' + name + (detail ? ` — ${detail}` : '')); }
  };

  const admin: Actor = { id: 'adm1', type: 'admin', role: 'admin', email: 'admin.it@hrelectriccompany.com', displayName: 'Admin' };
  const TOKEN = 'BEARER-TOKEN-SECRET-DO-NOT-LOG';
  const SECRET_REF = 'kv://watson-graph-secret';
  const cfg: GraphConfig = {
    tenantId: 't-123', clientId: 'c-123', clientSecretRef: SECRET_REF,
    keyVaultUrl: 'https://kv.vault.azure.net', graphBaseUrl: 'https://graph.microsoft.com/v1.0',
    liveReadOnlyEnabled: true
  };

  function fakeHttp(ordered: Array<[string, Resp]>, token = TOKEN): GraphHttpClient {
    return {
      async getToken() { return token; },
      async get(path: string) {
        for (const [k, v] of ordered) if (path.includes(k)) return v;
        return { status: 500, body: null };
      }
    };
  }

  console.log('\n[11] Microsoft Graph read-only connector');

  // 1. Mock remains the default provider.
  const def = getM365ReadOnlyConnector({ env: {} as NodeJS.ProcessEnv });
  check('mock read-only connector is the default', def.mode === 'mock' && def.id === 'mock-microsoft365-readonly');
  const def2 = getM365ReadOnlyConnector({
    env: { IT_AGENT_GRAPH_LIVE_READONLY: 'true', GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET_KEYVAULT_REF: 'kv' } as unknown as NodeJS.ProcessEnv
  });
  check('falls back to mock when gate on but no HTTP client supplied', def2.mode === 'mock');

  // 2. Graph cannot initialize without the explicit gate.
  let gateBlocked = false;
  try { createGraphConnector({ ...cfg, liveReadOnlyEnabled: false }, fakeHttp([])); } catch { gateBlocked = true; }
  check('Graph connector cannot initialize without live read-only gate', gateBlocked);

  // 3. Graph cannot initialize without required config.
  let cfgBlocked = false;
  try { createGraphConnector({ ...cfg, tenantId: '' }, fakeHttp([])); } catch { cfgBlocked = true; }
  check('Graph connector cannot initialize without required config', cfgBlocked);
  check('loadGraphConfig returns null when refs missing', loadGraphConfig({ IT_AGENT_GRAPH_LIVE_READONLY: 'true' } as unknown as NodeJS.ProcessEnv) === null);

  // 5. Each method maps a mocked Graph response into the normalized shape.
  const conn = createGraphConnector(cfg, fakeHttp([
    ['/licenseDetails', { status: 200, body: { value: [{ skuPartNumber: 'SPE_F1' }, { skuPartNumber: 'EXCHANGE_S_DESKLESS' }] } }],
    ['/authentication/methods', { status: 200, body: { value: [{ '@odata.type': '#microsoft.graph.passwordAuthenticationMethod' }, { '@odata.type': '#microsoft.graph.microsoftAuthenticatorAuthenticationMethod' }] } }],
    ['/mailboxSettings', { status: 200, body: {} }],
    ['/transitiveMemberOf', { status: 200, body: { value: [{ displayName: 'All Staff' }, { displayName: 'Field' }] } }],
    ['/users/', { status: 200, body: { id: 'u1', displayName: 'Carlos Field', userPrincipalName: 'carlos.field@hrelectriccompany.com', mail: 'carlos.field@hrelectriccompany.com', jobTitle: 'Field Electrician', department: 'Field', accountEnabled: true } }]
  ]));
  const u = await conn.lookupUser('carlos.field@hrelectriccompany.com', admin);
  check('graph lookupUser maps to normalized user', u.source === 'graph' && u.state === 'ok' && u.data?.displayName === 'Carlos Field' && u.data?.accountEnabled === true);
  const lic = await conn.checkLicenseStatus('carlos.field@hrelectriccompany.com', admin);
  check('graph checkLicenseStatus maps SKUs', lic.state === 'ok' && Array.isArray(lic.data?.licenses) && Boolean(lic.data?.licenses.includes('SPE_F1')));
  const mfa = await conn.checkMfaStatus('carlos.field@hrelectriccompany.com', admin);
  check('graph checkMfaStatus derives strong-auth posture', mfa.state === 'ok' && mfa.data?.mfaEnabled === true && (mfa.data?.mfaMethods.length ?? 0) >= 1);
  const grp = await conn.checkGroupMembership('carlos.field@hrelectriccompany.com', admin);
  check('graph checkGroupMembership maps group names', grp.state === 'ok' && Boolean(grp.data?.groups.includes('Field')));

  // 6. Missing/limited data => fail-soft, never fabricated success.
  const mb = await conn.checkMailboxStatus('carlos.field@hrelectriccompany.com', admin);
  check('graph mailbox size/quota fail-soft to unavailable (no fabrication)', mb.state === 'unavailable' && mb.data?.mailboxSizeGb === null && mb.data?.mailboxQuotaGb === null);
  const conn403 = createGraphConnector(cfg, fakeHttp([['/authentication/methods', { status: 403, body: null }]]));
  const mfa403 = await conn403.checkMfaStatus('x@hrelectriccompany.com', admin);
  check('graph MFA 403 => unavailable, not false success', mfa403.state === 'unavailable' && mfa403.data === null);
  const conn404 = createGraphConnector(cfg, fakeHttp([['/users/', { status: 404, body: null }]]));
  const u404 = await conn404.lookupUser('ghost@hrelectriccompany.com', admin);
  check('graph user 404 => not_found', u404.state === 'not_found' && u404.data === null);

  // 4. Secrets/tokens are never logged or audited.
  const logs: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
  console.warn = (...a: unknown[]) => { logs.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { logs.push(a.join(' ')); };
  try {
    await conn.lookupUser('carlos.field@hrelectriccompany.com', admin);
    await conn.checkLicenseStatus('carlos.field@hrelectriccompany.com', admin);
  } finally {
    console.log = orig.log; console.warn = orig.warn; console.error = orig.error;
  }
  const auditDump = JSON.stringify(listAudit({ limit: 2000 }));
  check('bearer token never written to console', !logs.join('\n').includes(TOKEN));
  check('bearer token never written to audit log', !auditDump.includes(TOKEN));
  check('live read attempts are audited (without secrets)', listAudit({ action: 'connector_live_read_attempted', limit: 50 }).length > 0);

  // 7 + 8. Guardrails intact; no live calls on the default/CI path.
  check('master live-execution gate still OFF after graph use', isLiveExternalExecutionEnabled() === false);
  check('default connector requires no network (mock) in test/CI', getM365ReadOnlyConnector().mode === 'mock');

  // ----------------------------------------------------------------
  // [12] URL-safety helpers (pure; no network) — token never leaves Graph host
  // ----------------------------------------------------------------
  console.log('\n[12] Graph URL-safety + Retry-After parsing');
  check('resolveGraphUrl prefixes relative path onto versioned base',
    resolveGraphUrl('/users/x', 'https://graph.microsoft.com/v1.0') === 'https://graph.microsoft.com/v1.0/users/x');
  let hostileRejected = false;
  try { resolveGraphUrl('https://evil.example.com/steal', 'https://graph.microsoft.com/v1.0'); } catch { hostileRejected = true; }
  check('resolveGraphUrl rejects absolute non-Graph host', hostileRejected);
  check('resolveGraphUrl allows a same-origin absolute nextLink',
    resolveGraphUrl('https://graph.microsoft.com/v1.0/users?$skiptoken=abc', 'https://graph.microsoft.com/v1.0')
      === 'https://graph.microsoft.com/v1.0/users?$skiptoken=abc');
  check('isSameGraphOrigin true for graph host', isSameGraphOrigin('https://graph.microsoft.com/v1.0/users', 'https://graph.microsoft.com/v1.0'));
  check('isSameGraphOrigin false for foreign host', !isSameGraphOrigin('https://graph.microsoft.com.evil.com/x', 'https://graph.microsoft.com/v1.0'));
  check('isSameGraphOrigin false for junk', !isSameGraphOrigin('not-a-url', 'https://graph.microsoft.com/v1.0'));
  check('parseRetryAfterSeconds parses integer seconds', parseRetryAfterSeconds('120') === 120);
  check('parseRetryAfterSeconds ignores HTTP-date form', parseRetryAfterSeconds('Wed, 21 Oct 2026 07:28:00 GMT') === undefined);
  check('parseRetryAfterSeconds ignores null/garbage', parseRetryAfterSeconds(null) === undefined && parseRetryAfterSeconds('abc') === undefined);

  // ----------------------------------------------------------------
  // [13] Malicious / malformed user identifiers cannot alter the request path
  // ----------------------------------------------------------------
  console.log('\n[13] Identifier encoding & injection resistance');
  {
    const rec = recordingHttp([['/users/', { status: 200, body: { id: 'u1', displayName: 'X', mail: 'x@y.com', accountEnabled: true } }]]);
    const conn13 = createGraphConnector(cfg, rec.http);
    await conn13.lookupUser('evil/../..%2f?$filter=1@hrelectriccompany.com', admin);
    const path = rec.calls[0] ?? '';
    const idSeg = path.slice(path.indexOf('/users/') + '/users/'.length);
    // The identifier is percent-encoded: no raw slash can add a path segment and
    // no raw '?'/'&' can inject query options before our own $select.
    check('identifier is percent-encoded (slash neutralized)', idSeg.includes('%2F') || idSeg.includes('%2f'));
    check('identifier cannot inject a path segment before our query', !idSeg.slice(0, idSeg.indexOf('?')).includes('/'));
    check('identifier cannot inject a $filter query option', !path.includes('$filter'));
  }

  // ----------------------------------------------------------------
  // [14] Pagination follows same-origin @odata.nextLink; refuses hostile host
  // ----------------------------------------------------------------
  console.log('\n[14] Pagination & hostile nextLink');
  {
    const page2Url = 'https://graph.microsoft.com/v1.0/users/x/transitiveMemberOf/microsoft.graph.group?$skiptoken=PAGE2';
    const rec = recordingHttp([
      ['PAGE2', { status: 200, body: { value: [{ displayName: 'Group-B' }] } }],
      ['/transitiveMemberOf', { status: 200, body: { value: [{ displayName: 'Group-A' }], '@odata.nextLink': page2Url } }]
    ]);
    const conn14 = createGraphConnector(cfg, rec.http);
    const grp = await conn14.checkGroupMembership('x@hrelectriccompany.com', admin);
    check('pagination merges values across pages', grp.state === 'ok' && Boolean(grp.data?.groups.includes('Group-A')) && Boolean(grp.data?.groups.includes('Group-B')));
    check('pagination made exactly two GET calls', rec.calls.length === 2);
  }
  {
    const evil = 'https://evil.example.com/v1.0/users/x/transitiveMemberOf?$skiptoken=EVIL';
    const rec = recordingHttp([
      ['/transitiveMemberOf', { status: 200, body: { value: [{ displayName: 'Group-A' }], '@odata.nextLink': evil } }]
    ]);
    const conn = createGraphConnector(cfg, rec.http);
    const grp = await conn.checkGroupMembership('x@hrelectriccompany.com', admin);
    check('hostile @odata.nextLink is NOT followed', grp.state === 'ok' && grp.data?.groups.length === 1);
    check('hostile host was never requested', !rec.calls.some((c) => c.includes('evil.example.com')));
  }

  // ----------------------------------------------------------------
  // [15] Transient-failure retry: 429 Retry-After, 5xx exhaustion, network error
  // ----------------------------------------------------------------
  console.log('\n[15] Retry / backoff / Retry-After');
  {
    const { sleeps, deps } = testDeps();
    const rec = recordingHttp([
      ['/transitiveMemberOf', [
        { status: 429, body: null, retryAfterSeconds: 2 },
        { status: 200, body: { value: [{ displayName: 'Group-A' }] } }
      ]]
    ]);
    const conn = createGraphConnector(cfg, rec.http, deps);
    const grp = await conn.checkGroupMembership('x@hrelectriccompany.com', admin);
    check('429 then 200 => retried to success', grp.state === 'ok' && Boolean(grp.data?.groups.includes('Group-A')));
    check('server Retry-After (2s) was honored as backoff', sleeps.includes(2000));
    check('429 retry made exactly two calls', rec.calls.length === 2);
  }
  {
    const { deps } = testDeps();
    const rec = recordingHttp([['/transitiveMemberOf', { status: 503, body: null }]]);
    const conn = createGraphConnector(cfg, rec.http, deps);
    const grp = await conn.checkGroupMembership('x@hrelectriccompany.com', admin);
    check('persistent 5xx => bounded retry then unavailable', grp.state === 'unavailable' && grp.data === null);
    check('5xx retries are bounded (1 + MAX_RETRIES = 4 calls)', rec.calls.length === 4);
  }
  {
    const { deps } = testDeps();
    const rec = recordingHttp([['/users/', [THROW, { status: 200, body: { id: 'u', displayName: 'Rec', mail: 'r@y.com', accountEnabled: true } }]]]);
    const conn = createGraphConnector(cfg, rec.http, deps);
    const u = await conn.lookupUser('r@y.com', admin);
    check('transient network/timeout error is retried then succeeds', u.state === 'ok' && u.data?.displayName === 'Rec');
  }
  {
    const { deps } = testDeps();
    const rec = recordingHttp([['/users/', THROW]]);
    const conn = createGraphConnector(cfg, rec.http, deps);
    const u = await conn.lookupUser('r@y.com', admin);
    check('persistent timeout/network error => unavailable (no crash)', u.state === 'unavailable' && u.data === null);
  }

  // ----------------------------------------------------------------
  // [16] Permanent auth failures are NOT retried (no retry storm)
  // ----------------------------------------------------------------
  console.log('\n[16] Permanent failures not retried');
  {
    const rec = recordingHttp([['/users/', { status: 401, body: null }]]);
    const conn = createGraphConnector(cfg, rec.http);
    const u = await conn.lookupUser('x@y.com', admin);
    check('401 => unavailable and NOT retried (single call)', u.state === 'unavailable' && rec.calls.length === 1);
  }
  {
    const rec = recordingHttp([['/licenseDetails', { status: 403, body: null }]]);
    const conn = createGraphConnector(cfg, rec.http);
    const lic = await conn.checkLicenseStatus('x@y.com', admin);
    check('403 => unavailable and NOT retried (single call)', lic.state === 'unavailable' && rec.calls.length === 1);
  }
  {
    const rec = recordingHttp([['/transitiveMemberOf', { status: 404, body: null }]]);
    const conn = createGraphConnector(cfg, rec.http);
    const grp = await conn.checkGroupMembership('x@y.com', admin);
    check('collection 404 => not_found, single call', grp.state === 'not_found' && rec.calls.length === 1);
  }

  // ----------------------------------------------------------------
  // [17] Null / malformed / partial responses never fabricate success
  // ----------------------------------------------------------------
  console.log('\n[17] Null / malformed / partial responses');
  {
    const conn = createGraphConnector(cfg, recordingHttp([['/users/', { status: 200, body: null }]]).http);
    const u = await conn.lookupUser('x@y.com', admin);
    check('200 with null body => unavailable (not false success)', u.state === 'unavailable' && u.data === null);
  }
  {
    const conn = createGraphConnector(cfg, recordingHttp([['/users/', { status: 200, body: 'oops-not-json-object' }]]).http);
    const u = await conn.lookupUser('x@y.com', admin);
    check('200 with non-object body => unavailable', u.state === 'unavailable');
  }
  {
    const conn = createGraphConnector(cfg, recordingHttp([['/users/', { status: 200, body: { id: 'u2', mail: 'p@y.com' } }]]).http);
    const u = await conn.lookupUser('p@y.com', admin);
    check('partial user (no accountEnabled) => null, not a fabricated boolean', u.state === 'ok' && u.data?.accountEnabled === null && u.data?.displayName === '');
  }
  {
    const conn = createGraphConnector(cfg, recordingHttp([['/licenseDetails', { status: 200, body: {} }]]).http);
    const lic = await conn.checkLicenseStatus('p@y.com', admin);
    check('empty license collection => ok with zero licenses', lic.state === 'ok' && lic.data?.licenses.length === 0);
  }

  // ----------------------------------------------------------------
  // [18] MFA interpretation is honest: weak factors excluded, no over-claim
  // ----------------------------------------------------------------
  console.log('\n[18] MFA interpretation');
  {
    const conn = createGraphConnector(cfg, recordingHttp([['/authentication/methods', { status: 200, body: { value: [
      { '@odata.type': '#microsoft.graph.passwordAuthenticationMethod' },
      { '@odata.type': '#microsoft.graph.emailAuthenticationMethod' }
    ] } }]]).http);
    const mfa = await conn.checkMfaStatus('x@y.com', admin);
    check('password + email only => mfaEnabled false (weak factors excluded)', mfa.state === 'ok' && mfa.data?.mfaEnabled === false && mfa.data?.mfaMethods.length === 0);
    check('MFA result is annotated as registration, not enforcement', typeof mfa.note === 'string' && /not enforced/i.test(mfa.note ?? ''));
  }
  {
    const conn = createGraphConnector(cfg, recordingHttp([['/authentication/methods', { status: 200, body: { value: [
      { '@odata.type': '#microsoft.graph.passwordAuthenticationMethod' },
      { '@odata.type': '#microsoft.graph.fido2AuthenticationMethod' }
    ] } }]]).http);
    const mfa = await conn.checkMfaStatus('x@y.com', admin);
    check('strong factor (fido2) => mfaEnabled true with method listed', mfa.state === 'ok' && mfa.data?.mfaEnabled === true && Boolean(mfa.data?.mfaMethods.includes('fido2')));
  }

  // ----------------------------------------------------------------
  // [19] Redaction holds across retry/pagination paths
  // ----------------------------------------------------------------
  console.log('\n[19] Redaction across live-read paths');
  {
    const rec = recordingHttp([
      ['PAGE2b', { status: 200, body: { value: [{ displayName: 'G2' }] } }],
      ['/transitiveMemberOf', [
        { status: 429, body: null, retryAfterSeconds: 1 },
        { status: 200, body: { value: [{ displayName: 'G1' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/x?$skiptoken=PAGE2b' } }
      ]]
    ], TOKEN);
    const { deps } = testDeps();
    const conn = createGraphConnector(cfg, rec.http, deps);
    await conn.checkGroupMembership('x@hrelectriccompany.com', admin);
    const dump = JSON.stringify(listAudit({ limit: 5000 }));
    check('token never appears in audit even across retry+pagination', !dump.includes(TOKEN));
    check('key-vault secret ref never appears in audit', !dump.includes(SECRET_REF));
    check('no Authorization/Bearer header value leaked to audit', !/Bearer /i.test(dump));
  }

  return { pass, fail, failures };
}
