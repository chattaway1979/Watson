/* ============================================================
 * Watson — H&R AI IT Agent : Live read-only Graph integration
 * self-tests (Key Vault SecretProvider assembly, production bootstrap,
 * and route live/mock/fail-closed). Invoked from it-agent-selftest.ts.
 *
 * NO network and NO real Azure/Graph client: every live path is driven by
 * injected fake Key Vault clients and fake Graph transports. The real Azure
 * SDK factory is never invoked (dynamic import never runs), proven by a
 * throwing spy that must NOT be called in mock mode.
 * ============================================================ */
import { listAudit } from '../src/lib/it-agent/audit';
import { listApprovals } from '../src/lib/it-agent/approval-engine';
import { isLiveExternalExecutionEnabled } from '../src/lib/it-agent/constants';
import {
  createAzureKeyVaultSecretProvider,
  type KeyVaultSecretClient,
  type GraphConfig,
  type GraphHttpClient
} from '../src/lib/it-agent/graph/graph-config';
import {
  bootstrapM365ReadOnlyConnector,
  graphLiveReadinessStatus,
  __setGraphLiveFactoriesForTests,
  __resetGraphLiveFactoriesForTests
} from '../src/lib/it-agent/graph/graph-bootstrap';
import { GET } from '../src/app/api/it-agent/diagnostics/m365/route';

type Resp = { status: number; body: unknown };
const BASE = 'http://localhost/api/it-agent/diagnostics/m365';

export async function runGraphLiveIntegrationTests(): Promise<{ pass: number; fail: number; failures: string[] }> {
  let pass = 0;
  let fail = 0;
  const failures: string[] = [];
  const check = (name: string, cond: boolean, detail = '') => {
    if (cond) { pass++; console.log('  ✅ ' + name); }
    else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log('  ❌ ' + name + (detail ? ` — ${detail}` : '')); }
  };

  const SECRET = 'KV-CLIENT-SECRET-DO-NOT-LOG';
  const TOKEN = 'BEARER-TOKEN-SECRET-DO-NOT-LOG';
  const user = 'sarah.office@hrelectriccompany.com';

  const FULL_LIVE_ENV = {
    IT_AGENT_GRAPH_LIVE_READONLY: 'true',
    GRAPH_TENANT_ID: 't-123', GRAPH_CLIENT_ID: 'c-123',
    GRAPH_CLIENT_SECRET_KEYVAULT_REF: 'watson-graph-secret',
    AZURE_KEY_VAULT_URL: 'https://kv.vault.azure.net',
    GRAPH_BASE_URL: 'https://graph.microsoft.com/v1.0'
  } as unknown as NodeJS.ProcessEnv;

  const okKvClient: KeyVaultSecretClient = { async getSecret() { return { value: SECRET }; } };
  const fakeHttp = (routes: Array<[string, Resp]>): GraphHttpClient => ({
    async getToken() { return TOKEN; },
    async get(path: string) { for (const [k, v] of routes) if (path.includes(k)) return v; return { status: 500, body: null }; }
  });
  const userHttp = () => fakeHttp([['/users/', { status: 200, body: { id: 'u1', displayName: 'Sarah Office', mail: user, accountEnabled: true } }]]);

  // ================================================================
  console.log('\n[30] Azure Key Vault adapter → SecretProvider (fail-closed)');
  // ================================================================
  const okProvider = createAzureKeyVaultSecretProvider({ keyVaultUrl: 'https://kv', client: okKvClient });
  check('adapter maps a successful getSecret', (await okProvider.getSecret('ref')) === SECRET);
  check('missing vault URL => fail closed', (await createAzureKeyVaultSecretProvider({ keyVaultUrl: '', client: okKvClient }).getSecret('ref')) === null);
  check('missing client => fail closed', (await createAzureKeyVaultSecretProvider({ keyVaultUrl: 'https://kv', client: undefined as unknown as KeyVaultSecretClient }).getSecret('ref')) === null);
  check('secret not found => fail closed', (await createAzureKeyVaultSecretProvider({ keyVaultUrl: 'https://kv', client: { async getSecret() { return null; } } }).getSecret('ref')) === null);
  check('empty secret => fail closed', (await createAzureKeyVaultSecretProvider({ keyVaultUrl: 'https://kv', client: { async getSecret() { return { value: '' }; } } }).getSecret('ref')) === null);
  const deniedClient: KeyVaultSecretClient = { async getSecret() { throw new Error('403 Forbidden secret=' + SECRET); } };
  const deniedProvider = createAzureKeyVaultSecretProvider({ keyVaultUrl: 'https://kv', client: deniedClient });
  let threw = false; let denRes: string | null = 'x';
  try { denRes = await deniedProvider.getSecret('ref'); } catch { threw = true; }
  check('access denied / SDK throw => fail closed (null, no throw)', threw === false && denRes === null);

  // Secret never leaks via logs while resolving through the adapter/provider.
  const logs: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
  console.warn = (...a: unknown[]) => { logs.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { logs.push(a.join(' ')); };
  const auditBefore = listAudit({ limit: 5000 }).length;
  try { await okProvider.getSecret('ref'); await deniedProvider.getSecret('ref'); }
  finally { console.log = orig.log; console.warn = orig.warn; console.error = orig.error; }
  check('secret sentinel never logged', !logs.join('\n').includes(SECRET));
  check('SecretProvider writes no audit (no secret in audit)', listAudit({ limit: 5000 }).length === auditBefore);

  // ================================================================
  console.log('\n[31] Production bootstrap — mock default & Azure not constructed');
  // ================================================================
  // A spy factory that MUST NOT run in mock mode (would throw if constructed).
  __setGraphLiveFactoriesForTests({ kv: () => { throw new Error('Azure KV client must NOT be constructed in mock mode'); } });
  try {
    check('gate absent => mock (Azure never constructed)', (await bootstrapM365ReadOnlyConnector({ env: {} as NodeJS.ProcessEnv })).mode === 'mock');
    check('gate false => mock', (await bootstrapM365ReadOnlyConnector({ env: { IT_AGENT_GRAPH_LIVE_READONLY: 'false' } as unknown as NodeJS.ProcessEnv })).mode === 'mock');
    check('gate malformed => mock', (await bootstrapM365ReadOnlyConnector({ env: { IT_AGENT_GRAPH_LIVE_READONLY: 'maybe' } as unknown as NodeJS.ProcessEnv })).mode === 'mock');
  } finally { __resetGraphLiveFactoriesForTests(); }

  // ================================================================
  console.log('\n[32] Production bootstrap — live assembly & fail-closed matrix');
  // ================================================================
  const liveOk = await bootstrapM365ReadOnlyConnector({
    env: FULL_LIVE_ENV,
    keyVaultClientFactory: () => okKvClient,
    httpClientFactory: () => userHttp()
  });
  check('full valid config + fakes => live_readonly assembled', liveOk.mode === 'live_readonly');

  const noTenant = await bootstrapM365ReadOnlyConnector({ env: { ...FULL_LIVE_ENV, GRAPH_TENANT_ID: '' } as NodeJS.ProcessEnv, keyVaultClientFactory: () => okKvClient, httpClientFactory: () => userHttp() });
  check('missing tenant => fail_closed (graph_config_incomplete)', noTenant.mode === 'fail_closed' && (noTenant as { reason: string }).reason === 'graph_config_incomplete');
  const noClient = await bootstrapM365ReadOnlyConnector({ env: { ...FULL_LIVE_ENV, GRAPH_CLIENT_ID: '' } as NodeJS.ProcessEnv, keyVaultClientFactory: () => okKvClient });
  check('missing client id => fail_closed', noClient.mode === 'fail_closed');
  const noRef = await bootstrapM365ReadOnlyConnector({ env: { ...FULL_LIVE_ENV, GRAPH_CLIENT_SECRET_KEYVAULT_REF: '' } as NodeJS.ProcessEnv, keyVaultClientFactory: () => okKvClient });
  check('missing secret reference => fail_closed', noRef.mode === 'fail_closed');
  const noVault = await bootstrapM365ReadOnlyConnector({ env: { ...FULL_LIVE_ENV, AZURE_KEY_VAULT_URL: '' } as NodeJS.ProcessEnv, keyVaultClientFactory: () => okKvClient });
  check('missing vault config => fail_closed (keyvault_not_configured)', noVault.mode === 'fail_closed' && (noVault as { reason: string }).reason === 'keyvault_not_configured');
  const secretNull = await bootstrapM365ReadOnlyConnector({ env: FULL_LIVE_ENV, keyVaultClientFactory: () => ({ async getSecret() { return null; } }), httpClientFactory: () => userHttp() });
  check('secret unavailable => fail_closed (live_connector_unavailable)', secretNull.mode === 'fail_closed' && (secretNull as { reason: string }).reason === 'live_connector_unavailable');
  const azThrow = await bootstrapM365ReadOnlyConnector({ env: FULL_LIVE_ENV, keyVaultClientFactory: () => { throw new Error('identity unavailable'); } });
  check('Azure construction throw => fail_closed (azure_bootstrap_error)', azThrow.mode === 'fail_closed' && (azThrow as { reason: string }).reason === 'azure_bootstrap_error');

  // reason codes carry NO config values / secrets.
  const allReasons = [noTenant, noClient, noRef, noVault, secretNull, azThrow].map((r) => (r as { reason?: string }).reason ?? '').join(' ');
  check('fail_closed reasons are safe codes (no values/secrets)', !allReasons.includes(SECRET) && !allReasons.includes('t-123') && !allReasons.includes('kv.vault') && !/https?:/.test(allReasons));

  // readiness status = booleans only, no values.
  const status = graphLiveReadinessStatus(FULL_LIVE_ENV);
  const statusDump = JSON.stringify(status);
  check('readiness status is booleans only (no values)', Object.values(status).every((v) => typeof v === 'boolean') && !statusDump.includes('t-123') && !statusDump.includes('kv.vault') && !statusDump.includes(SECRET));
  check('readiness reflects a would-attempt gate', status.liveReadWouldAttempt === true && graphLiveReadinessStatus({} as NodeJS.ProcessEnv).liveReadWouldAttempt === false);

  // ================================================================
  console.log('\n[33] Route integration — mock default, live via gate, fail-closed');
  // ================================================================
  const callRoute = async (query: string, headers: Record<string, string>) => {
    const res = await GET(new Request(BASE + query, { headers }));
    return { status: res.status, body: (await res.json()) as { ok: boolean; data?: { outcome?: string; connector?: string; result?: unknown }; error?: string }, cache: res.headers.get('cache-control') };
  };
  const ADMIN = { 'x-watson-role': 'admin' };

  const savedGate = process.env.IT_AGENT_GRAPH_LIVE_READONLY;
  try {
    // Default (gate off): route uses mock.
    delete process.env.IT_AGENT_GRAPH_LIVE_READONLY;
    const mockRes = await callRoute('?read=lookup_user&target=' + user, ADMIN);
    check('route mock by default => 200 evidence via mock', mockRes.status === 200 && mockRes.body.data?.outcome === 'evidence' && mockRes.body.data?.connector === 'mock');

    // Gate on + full env + injected live factories: route uses live_readonly.
    for (const [k, v] of Object.entries(FULL_LIVE_ENV)) process.env[k] = v as string;
    __setGraphLiveFactoriesForTests({ kv: () => okKvClient, http: () => userHttp() });
    const liveRes = await callRoute('?read=lookup_user&target=' + user, ADMIN);
    check('route uses injected live_readonly when full gate satisfied', liveRes.status === 200 && liveRes.body.data?.outcome === 'evidence' && liveRes.body.data?.connector === 'live_readonly');
    const liveDump = JSON.stringify(liveRes.body);
    check('route live response is normalized (no raw Graph / token / secret)', !liveDump.includes('@odata') && !liveDump.includes('onPremises') && !liveDump.includes(TOKEN) && !liveDump.includes(SECRET));
    check('route live response is no-store', liveRes.cache === 'no-store');

    // Gate on but secret unavailable: route returns normalized not_configured.
    __setGraphLiveFactoriesForTests({ kv: () => ({ async getSecret() { return null; } }), http: () => userHttp() });
    const failRes = await callRoute('?read=lookup_user&target=' + user, ADMIN);
    check('route incomplete live config => 200 not_configured (fail-closed, no mock fallback)', failRes.status === 200 && failRes.body.data?.outcome === 'not_configured');
    check('not_configured reason is a safe code (no values/secret)', (() => { const r = (failRes.body.data as { reason?: string }).reason ?? ''; return !r.includes(SECRET) && !r.includes('t-123') && !/https?:/.test(r); })());
  } finally {
    __resetGraphLiveFactoriesForTests();
    for (const k of Object.keys(FULL_LIVE_ENV)) delete process.env[k];
    if (savedGate === undefined) delete process.env.IT_AGENT_GRAPH_LIVE_READONLY;
    else process.env.IT_AGENT_GRAPH_LIVE_READONLY = savedGate;
  }

  // ================================================================
  console.log('\n[34] Route integration — no side effects / guardrails intact');
  // ================================================================
  const apprBefore = listApprovals().length;
  const mockExecBefore = listAudit({ action: 'mock_action_executed', limit: 5000 }).length;
  const apprReqBefore = listAudit({ action: 'approval_requested', limit: 5000 }).length;
  for (const r of ['lookup_user', 'check_license_status', 'check_mfa_status', 'check_mailbox_status', 'check_group_membership']) {
    await callRoute('?read=' + r + '&target=' + user, ADMIN);
  }
  check('route reads create no approvals', listApprovals().length === apprBefore);
  check('route reads emit no mock_action_executed', listAudit({ action: 'mock_action_executed', limit: 5000 }).length === mockExecBefore);
  check('route reads emit no approval_requested', listAudit({ action: 'approval_requested', limit: 5000 }).length === apprReqBefore);
  check('general live external execution remains disabled', isLiveExternalExecutionEnabled() === false);
  const auditDump = JSON.stringify(listAudit({ limit: 5000 }));
  check('no token/secret sentinel in audit output', !auditDump.includes(TOKEN) && !auditDump.includes(SECRET));

  return { pass, fail, failures };
}
