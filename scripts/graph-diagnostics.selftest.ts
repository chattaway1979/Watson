/* ============================================================
 * Watson — H&R AI IT Agent : M365 read-only diagnostics + Key Vault
 * SecretProvider self-tests. Invoked from it-agent-selftest.ts.
 * NO network: a fake GraphHttpClient and a fake Key Vault client are
 * injected for every case; the default/gate paths never construct a
 * real client. Proves the safety model, not just the happy path.
 * ============================================================ */
import { listAudit } from '../src/lib/it-agent/audit';
import { isLiveExternalExecutionEnabled } from '../src/lib/it-agent/constants';
import { listApprovals } from '../src/lib/it-agent/approval-engine';
import { invokeAction } from '../src/lib/it-agent/tool-gateway';
import {
  runM365Diagnostic,
  resolveM365ReadOnlyConnector
} from '../src/lib/it-agent/graph/graph-diagnostics';
import {
  createAzureKeyVaultSecretProvider,
  type KeyVaultSecretClient,
  type GraphConfig,
  type GraphHttpClient
} from '../src/lib/it-agent/graph/graph-config';
import type { Actor } from '../src/lib/it-agent/types';

type Resp = { status: number; body: unknown; retryAfterSeconds?: number };

export async function runGraphDiagnosticsTests(): Promise<{ pass: number; fail: number; failures: string[] }> {
  let pass = 0;
  let fail = 0;
  const failures: string[] = [];
  const check = (name: string, cond: boolean, detail = '') => {
    if (cond) { pass++; console.log('  ✅ ' + name); }
    else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log('  ❌ ' + name + (detail ? ` — ${detail}` : '')); }
  };

  const admin: Actor = { id: 'adm1', type: 'admin', role: 'admin', email: 'admin.it@hrelectriccompany.com', displayName: 'Admin' };
  const employee: Actor = { id: 'emp1', type: 'user', role: 'employee', email: 'carlos.field@hrelectriccompany.com', displayName: 'Carlos' };
  const watson: Actor = { id: 'watson', type: 'agent', role: 'agent', email: 'watson@hrelectriccompany.com', displayName: 'Watson' };
  const seededUser = 'sarah.office@hrelectriccompany.com';

  const TOKEN = 'BEARER-TOKEN-SECRET-DO-NOT-LOG';
  const SECRET = 'KV-CLIENT-SECRET-DO-NOT-LOG';
  const LIVE_ENV = {
    IT_AGENT_GRAPH_LIVE_READONLY: 'true',
    GRAPH_TENANT_ID: 't-123', GRAPH_CLIENT_ID: 'c-123',
    GRAPH_CLIENT_SECRET_KEYVAULT_REF: 'kv://watson-graph-secret',
    GRAPH_BASE_URL: 'https://graph.microsoft.com/v1.0'
  } as unknown as NodeJS.ProcessEnv;
  const cfg: GraphConfig = {
    tenantId: 't-123', clientId: 'c-123', clientSecretRef: 'kv://watson-graph-secret',
    keyVaultUrl: 'https://kv.vault.azure.net', graphBaseUrl: 'https://graph.microsoft.com/v1.0',
    liveReadOnlyEnabled: true
  };
  function fakeHttp(routes: Array<[string, Resp]>, token = TOKEN): GraphHttpClient {
    return {
      async getToken() { return token; },
      async get(path: string) { for (const [k, v] of routes) if (path.includes(k)) return v; return { status: 500, body: null }; }
    };
  }
  const throwingHttp: GraphHttpClient = {
    async getToken() { return TOKEN; },
    async get() { throw new Error('simulated transport failure'); }
  };

  // ================================================================
  console.log('\n[20] Connector selection & live-read gate');
  // ================================================================
  const def = await resolveM365ReadOnlyConnector({ env: {} as NodeJS.ProcessEnv });
  check('mock connector is the default (no env)', def.mode === 'mock');
  check('live-read flag absent => mock', (await resolveM365ReadOnlyConnector({ env: { GRAPH_TENANT_ID: 't' } as unknown as NodeJS.ProcessEnv })).mode === 'mock');
  check('live-read flag false => mock', (await resolveM365ReadOnlyConnector({ env: { IT_AGENT_GRAPH_LIVE_READONLY: 'false' } as unknown as NodeJS.ProcessEnv })).mode === 'mock');
  check('live-read flag malformed => mock (strict truthiness)', (await resolveM365ReadOnlyConnector({ env: { IT_AGENT_GRAPH_LIVE_READONLY: 'maybe' } as unknown as NodeJS.ProcessEnv })).mode === 'mock');

  const incomplete = await resolveM365ReadOnlyConnector({ env: { IT_AGENT_GRAPH_LIVE_READONLY: 'true', GRAPH_TENANT_ID: 't' } as unknown as NodeJS.ProcessEnv, http: fakeHttp([]) });
  check('gate on + incomplete config => fail_closed', incomplete.mode === 'fail_closed');
  const noProvider = await resolveM365ReadOnlyConnector({ env: LIVE_ENV });
  check('gate on + no transport/SecretProvider => fail_closed', noProvider.mode === 'fail_closed');
  const missingSecret = await resolveM365ReadOnlyConnector({ env: LIVE_ENV, secretProvider: { id: 'x', async getSecret() { return null; } } });
  check('gate on + SecretProvider returns null => fail_closed', missingSecret.mode === 'fail_closed');
  const throwingSecret = await resolveM365ReadOnlyConnector({ env: LIVE_ENV, secretProvider: { id: 'x', async getSecret() { throw new Error('kv down'); } } });
  check('gate on + SecretProvider throws => fail_closed', throwingSecret.mode === 'fail_closed');

  const liveInjected = await resolveM365ReadOnlyConnector({ env: LIVE_ENV, http: fakeHttp([['/users/', { status: 200, body: { id: 'u', displayName: 'U', mail: 'u@y.com', accountEnabled: true } }]]) });
  check('gate on + valid injected transport => live_readonly', liveInjected.mode === 'live_readonly');
  const liveViaSecret = await resolveM365ReadOnlyConnector({
    env: LIVE_ENV,
    secretProvider: { id: 'kv', async getSecret() { return SECRET; } },
    httpClientFactory: () => fakeHttp([['/users/', { status: 200, body: { id: 'u', displayName: 'U', mail: 'u@y.com', accountEnabled: true } }]])
  });
  check('gate on + secret resolved + factory => live_readonly (no network)', liveViaSecret.mode === 'live_readonly');

  if (liveInjected.mode === 'live_readonly') {
    const writeNames = ['disableUser', 'deleteUser', 'wipeDevice', 'resetPassword', 'update', 'create', 'delete', 'remove', 'set', 'post', 'patch', 'put', 'write'];
    const c = liveInjected.connector as unknown as Record<string, unknown>;
    check('live connector exposes NO write-capable methods', writeNames.every((n) => typeof c[n] !== 'function'));
  } else { check('live connector exposes NO write-capable methods', false, 'live connector not constructed'); }

  // ================================================================
  console.log('\n[21] Diagnostic wireup (authorization + normalization)');
  // ================================================================
  const okDiag = await runM365Diagnostic(admin, 'lookup_user', seededUser);
  check('authorized admin diagnostic succeeds via mock', okDiag.outcome === 'evidence' && okDiag.connector === 'mock');
  check('result is a normalized ReadResult (source/state/data)', okDiag.outcome === 'evidence' && typeof okDiag.result.source === 'string' && typeof okDiag.result.state === 'string' && 'data' in okDiag.result);

  const denied = await runM365Diagnostic(employee, 'lookup_user', seededUser);
  check('unauthorized employee is denied (no evidence)', denied.outcome === 'denied');
  const deniedAgent = await runM365Diagnostic(watson, 'check_mfa_status', seededUser);
  check('agent below admin is denied', deniedAgent.outcome === 'denied');

  // Raw Graph payload must NOT leak — only the normalized shape is returned.
  const rawLeakHttp = fakeHttp([['/users/', { status: 200, body: {
    '@odata.context': 'https://graph.microsoft.com/$metadata#users/$entity',
    id: 'u9', displayName: 'Leak Test', mail: 'leak@y.com', userPrincipalName: 'leak@y.com',
    onPremisesSamAccountName: 'LEAK', accountEnabled: true, jobTitle: 'Eng', department: 'IT'
  } }]]);
  const rawDiag = await runM365Diagnostic(admin, 'lookup_user', 'leak@y.com', { env: LIVE_ENV, http: rawLeakHttp, requireLive: true });
  const normalizedKeys = ['accountEnabled', 'department', 'displayName', 'email', 'id', 'jobTitle'];
  check('live evidence is normalized (raw Graph fields stripped)',
    rawDiag.outcome === 'evidence' && rawDiag.connector === 'live_readonly' &&
    JSON.stringify(Object.keys(rawDiag.result.data as object).sort()) === JSON.stringify(normalizedKeys));
  check('raw @odata / onPrem fields never appear in evidence',
    rawDiag.outcome === 'evidence' && !JSON.stringify(rawDiag.result.data).includes('@odata') && !JSON.stringify(rawDiag.result.data).includes('onPremises'));

  // Evidence-state honesty across mailbox(partial)/500/403/throw/null.
  const partial = await runM365Diagnostic(admin, 'check_mailbox_status', 'x@y.com', { env: LIVE_ENV, http: fakeHttp([['/mailboxSettings', { status: 200, body: {} }]]), requireLive: true });
  check('partial evidence preserved (mailbox size/quota null, unavailable)',
    partial.outcome === 'evidence' && partial.result.state === 'unavailable' &&
    (partial.result.data as { mailboxSizeGb: number | null } | null)?.mailboxSizeGb === null);
  const upstream500 = await runM365Diagnostic(admin, 'check_group_membership', 'x@y.com', { env: LIVE_ENV, http: fakeHttp([['/transitiveMemberOf', { status: 500, body: null }]]), requireLive: true });
  check('upstream 5xx => unavailable (not fabricated healthy)', upstream500.outcome === 'evidence' && upstream500.result.state === 'unavailable');
  const denied403 = await runM365Diagnostic(admin, 'check_mfa_status', 'x@y.com', { env: LIVE_ENV, http: fakeHttp([['/authentication/methods', { status: 403, body: null }]]), requireLive: true });
  check('Graph 403 => unavailable with permission note (denied evidence)', denied403.outcome === 'evidence' && denied403.result.state === 'unavailable' && denied403.result.data === null);
  const threw = await runM365Diagnostic(admin, 'lookup_user', 'x@y.com', { env: LIVE_ENV, http: throwingHttp, requireLive: true });
  check('upstream transport throw => unavailable (no crash)', threw.outcome === 'evidence' && threw.result.state === 'unavailable');
  const malformed = await runM365Diagnostic(admin, 'lookup_user', 'x@y.com', { env: LIVE_ENV, http: fakeHttp([['/users/', { status: 200, body: null }]]), requireLive: true });
  check('malformed 200 (null body) => unavailable, not false success', malformed.outcome === 'evidence' && malformed.result.state === 'unavailable');
  const notFound = await runM365Diagnostic(admin, 'lookup_user', 'ghost@y.com', { env: LIVE_ENV, http: fakeHttp([['/users/', { status: 404, body: null }]]), requireLive: true });
  check('404 => not_found evidence (distinct from unavailable)', notFound.outcome === 'evidence' && notFound.result.state === 'not_found');

  // requireLive must fail closed rather than silently use mock.
  const requireLiveNoGate = await runM365Diagnostic(admin, 'lookup_user', seededUser, { env: {} as NodeJS.ProcessEnv, requireLive: true });
  check('requireLive with gate off => not_configured (never silent mock)', requireLiveNoGate.outcome === 'not_configured');
  const failClosedDiag = await runM365Diagnostic(admin, 'lookup_user', seededUser, { env: LIVE_ENV, requireLive: true });
  check('requireLive with no transport => not_configured', failClosedDiag.outcome === 'not_configured');

  // ================================================================
  console.log('\n[22] Diagnosis performs NO remediation / NO approval change');
  // ================================================================
  const approvalsBefore = listApprovals().length;
  const mockExecBefore = listAudit({ action: 'mock_action_executed', limit: 5000 }).length;
  const apprReqBefore = listAudit({ action: 'approval_requested', limit: 5000 }).length;
  await runM365Diagnostic(admin, 'lookup_user', seededUser);
  await runM365Diagnostic(admin, 'check_mfa_status', seededUser);
  await runM365Diagnostic(admin, 'check_group_membership', seededUser, { env: LIVE_ENV, http: fakeHttp([['/transitiveMemberOf', { status: 200, body: { value: [{ displayName: 'Field' }] } }]]), requireLive: true });
  check('no approvals created during diagnosis', listApprovals().length === approvalsBefore);
  check('no mock_action_executed emitted during diagnosis', listAudit({ action: 'mock_action_executed', limit: 5000 }).length === mockExecBefore);
  check('no approval_requested emitted during diagnosis', listAudit({ action: 'approval_requested', limit: 5000 }).length === apprReqBefore);

  // Unauthorized diagnostic performs no connector read at all.
  const preLeak = listAudit({ action: 'connector_mock_called', limit: 5000 }).filter((a) => a.targetId === 'nobody-secret@y.com').length;
  await runM365Diagnostic(employee, 'lookup_user', 'nobody-secret@y.com');
  check('unauthorized diagnostic performs no external/connector read', listAudit({ action: 'connector_mock_called', limit: 5000 }).filter((a) => a.targetId === 'nobody-secret@y.com').length === preLeak);

  // Tool-gateway remains authoritative & unaffected: a high-risk action still queues approval.
  const gwHigh = invokeAction(admin, { actionKey: 'prepare_password_reset', input: { email: seededUser, reason: 'x' } });
  check('tool-gateway still authoritative (high-risk => approval_required)', gwHigh.kind === 'approval_required');

  // The graph live-read gate is independent of the live-EXECUTION master switch.
  check('graph live-read enablement does NOT enable live external execution', isLiveExternalExecutionEnabled() === false);

  // ================================================================
  console.log('\n[23] Audit redaction across diagnostic paths');
  // ================================================================
  await runM365Diagnostic(admin, 'lookup_user', 'redact@y.com', { env: LIVE_ENV, http: fakeHttp([['/users/', { status: 200, body: { id: 'r', displayName: 'R', mail: 'r@y.com', accountEnabled: true } }]], TOKEN), requireLive: true });
  const dump = JSON.stringify(listAudit({ limit: 5000 }));
  check('bearer token never written to audit (diagnostic path)', !dump.includes(TOKEN));
  check('key-vault secret value never written to audit', !dump.includes(SECRET));
  check('no Authorization/Bearer header value leaked to audit', !/Bearer /i.test(dump));
  check('diagnostic_read_performed audit written (state only)', listAudit({ action: 'diagnostic_read_performed', limit: 50 }).length > 0);
  check('diagnostic_read_denied audit written for denials', listAudit({ action: 'diagnostic_read_denied', limit: 50 }).length > 0);

  // ================================================================
  console.log('\n[24] Azure Key Vault SecretProvider (fail-closed, DI, no network)');
  // ================================================================
  const okClient: KeyVaultSecretClient = { async getSecret() { return { value: SECRET }; } };
  const provider = createAzureKeyVaultSecretProvider({ keyVaultUrl: 'https://kv.vault.azure.net', client: okClient });
  check('injected fake client returns the secret', (await provider.getSecret('ref')) === SECRET);
  check('missing vault URL => fail closed', (await createAzureKeyVaultSecretProvider({ keyVaultUrl: '', client: okClient }).getSecret('ref')) === null);
  check('blank secret ref => fail closed', (await provider.getSecret('   ')) === null);
  check('empty secret ref => fail closed', (await provider.getSecret('')) === null);
  check('secret not found (client null) => fail closed', (await createAzureKeyVaultSecretProvider({ keyVaultUrl: 'https://kv', client: { async getSecret() { return null; } } }).getSecret('ref')) === null);
  check('empty secret value => fail closed', (await createAzureKeyVaultSecretProvider({ keyVaultUrl: 'https://kv', client: { async getSecret() { return { value: '' }; } } }).getSecret('ref')) === null);
  check('malformed value (non-string) => fail closed', (await createAzureKeyVaultSecretProvider({ keyVaultUrl: 'https://kv', client: { async getSecret() { return { value: 123 as unknown as string }; } } }).getSecret('ref')) === null);
  check('malformed response (missing value) => fail closed', (await createAzureKeyVaultSecretProvider({ keyVaultUrl: 'https://kv', client: { async getSecret() { return {} as { value?: string }; } } }).getSecret('ref')) === null);

  const deniedClient: KeyVaultSecretClient = { async getSecret() { throw new Error('403 Forbidden: access denied to secret ' + SECRET); } };
  const deniedProvider = createAzureKeyVaultSecretProvider({ keyVaultUrl: 'https://kv', client: deniedClient });
  let threwSecret = false; let providerResult: string | null = 'sentinel';
  try { providerResult = await deniedProvider.getSecret('ref'); } catch { threwSecret = true; }
  check('access denied / upstream throw => fail closed (returns null, does not throw)', threwSecret === false && providerResult === null);

  // The provider must not reveal the secret via logs while resolving it.
  const logs: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
  console.warn = (...a: unknown[]) => { logs.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { logs.push(a.join(' ')); };
  const auditBeforeKv = listAudit({ limit: 5000 }).length;
  try {
    await provider.getSecret('ref');
    await deniedProvider.getSecret('ref');
  } finally {
    console.log = orig.log; console.warn = orig.warn; console.error = orig.error;
  }
  check('SecretProvider never logs the secret value', !logs.join('\n').includes(SECRET));
  check('SecretProvider writes NO audit entries (no secret in audit)', listAudit({ limit: 5000 }).length === auditBeforeKv);

  return { pass, fail, failures };
}
