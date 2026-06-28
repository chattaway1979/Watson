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
import { loadGraphConfig } from '../src/lib/it-agent/graph/graph-config';
import type { GraphConfig, GraphHttpClient } from '../src/lib/it-agent/graph/graph-config';
import type { Actor } from '../src/lib/it-agent/types';

type Resp = { status: number; body: unknown };

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

  return { pass, fail, failures };
}
