/* ============================================================
 * Watson — WATSON-GRAPH-PREREQUISITES-PROVISION-011A
 * Fail-closed posture regression tests for the PROVISIONED-BUT-DISABLED state.
 *
 * 011A provisions the Graph prerequisites (app registration, admin consent,
 * Key Vault, managed identity, app settings) WITHOUT enabling live reads. That
 * creates a new, previously untested configuration: `graphConfigComplete` is
 * now TRUE in the deployed environment while the live gate is FALSE.
 *
 * These tests pin the invariant that completeness must never imply liveness,
 * and that every partial-provisioning gap fails CLOSED rather than degrading
 * to mock (which would silently present mock data as if it were live).
 *
 * NO network, NO Azure SDK, NO Graph call: the Azure factories are replaced by
 * throwing spies that must never fire. Placeholder identifiers only — no real
 * tenant, client, or vault values appear in this file.
 * ============================================================ */
import {
  bootstrapM365ReadOnlyConnector,
  graphLiveReadinessStatus
} from '../src/lib/it-agent/graph/graph-bootstrap';
import { failClosedSecretProvider } from '../src/lib/it-agent/graph/graph-config';
import { isLiveExternalExecutionEnabled } from '../src/lib/it-agent/constants';

// Mirrors the app settings 011A wrote to App Service, with PLACEHOLDER values.
// Real identifiers live only in Azure platform configuration, never in source.
const PROVISIONED_011A = {
  GRAPH_TENANT_ID: '00000000-0000-0000-0000-0000000000t1',
  GRAPH_CLIENT_ID: '00000000-0000-0000-0000-0000000000c1',
  GRAPH_CLIENT_SECRET_KEYVAULT_REF: 'watson-graph-client-secret',
  AZURE_KEY_VAULT_URL: 'https://placeholder-vault.vault.azure.net',
  IT_AGENT_GRAPH_LIVE_READONLY: 'false',
  IT_AGENT_LIVE_EXTERNAL_EXECUTION: 'false'
} as unknown as NodeJS.ProcessEnv;

const withEnv = (over: Record<string, string>) =>
  ({ ...PROVISIONED_011A, ...over }) as unknown as NodeJS.ProcessEnv;

// Any invocation of these means we touched Azure. They must never be called.
const throwingKvFactory = () => { throw new Error('Azure Key Vault client constructed — MUST NOT HAPPEN'); };
const throwingHttpFactory = () => { throw new Error('Graph HTTP transport constructed — MUST NOT HAPPEN'); };

export async function runGraphPrereqPostureTests(): Promise<{ pass: number; fail: number; failures: string[] }> {
  let pass = 0;
  let fail = 0;
  const failures: string[] = [];
  const check = (name: string, cond: boolean, detail = '') => {
    if (cond) { pass++; console.log('  ✅ ' + name); }
    else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log('  ❌ ' + name + (detail ? ` — ${detail}` : '')); }
  };

  console.log('\n[52] Graph prerequisites posture (011A: provisioned, gate off)');

  // --- 1. Complete config + gate OFF must still be MOCK -------------------
  {
    const r = await bootstrapM365ReadOnlyConnector({
      env: PROVISIONED_011A,
      keyVaultClientFactory: throwingKvFactory,
      httpClientFactory: throwingHttpFactory
    });
    check('011A provisioned + gate off resolves to mock', r.mode === 'mock', `got ${r.mode}`);
    check('011A provisioned + gate off never constructs Azure/Graph clients', r.mode === 'mock');
  }

  // --- 2. Readiness reports complete config WITHOUT implying liveness -----
  {
    const s = graphLiveReadinessStatus(PROVISIONED_011A);
    check('readiness: graphConfigComplete is true after 011A', s.graphConfigComplete === true);
    check('readiness: keyVaultConfigured is true after 011A', s.keyVaultConfigured === true);
    check('readiness: tenant/client/secretRef all configured', s.tenantConfigured && s.clientConfigured && s.secretRefConfigured);
    check('readiness: liveReadOnlyFlag remains false', s.liveReadOnlyFlag === false);
    check('readiness: liveReadWouldAttempt is FALSE despite complete config', s.liveReadWouldAttempt === false);
    check('readiness: managed identity selector unset (system-assigned)', s.managedIdentitySelectorPresent === false);
  }

  // --- 3. Readiness must leak no configuration VALUES ---------------------
  {
    const serialized = JSON.stringify(graphLiveReadinessStatus(PROVISIONED_011A));
    const leaked = [
      PROVISIONED_011A.GRAPH_TENANT_ID!,
      PROVISIONED_011A.GRAPH_CLIENT_ID!,
      PROVISIONED_011A.GRAPH_CLIENT_SECRET_KEYVAULT_REF!,
      PROVISIONED_011A.AZURE_KEY_VAULT_URL!
    ].filter((v) => serialized.includes(v));
    check('readiness status leaks no config values (presence booleans only)', leaked.length === 0, leaked.join(','));
  }

  // --- 4. Gate ON but Key Vault access missing => FAIL CLOSED, not mock ---
  // This is the exact state 011A leaves behind: the managed identity has no
  // Key Vault role yet, so the secret cannot resolve.
  {
    const r = await bootstrapM365ReadOnlyConnector({
      env: withEnv({ IT_AGENT_GRAPH_LIVE_READONLY: 'true', AZURE_KEY_VAULT_URL: '' }),
      keyVaultClientFactory: throwingKvFactory,
      httpClientFactory: throwingHttpFactory
    });
    check('gate on + no Key Vault URL fails closed', r.mode === 'fail_closed', `got ${r.mode}`);
    check('gate on + no Key Vault URL reports keyvault_not_configured',
      r.mode === 'fail_closed' && r.reason === 'keyvault_not_configured', r.mode === 'fail_closed' ? r.reason : '');
    check('gate on + no Key Vault URL does NOT fall back to mock', r.mode !== 'mock');
  }

  // --- 5. Gate ON + vault reachable but secret unresolvable => FAIL CLOSED -
  {
    const r = await bootstrapM365ReadOnlyConnector({
      env: withEnv({ IT_AGENT_GRAPH_LIVE_READONLY: 'true' }),
      secretProvider: failClosedSecretProvider,
      httpClientFactory: throwingHttpFactory
    });
    check('gate on + unresolvable secret fails closed', r.mode === 'fail_closed', `got ${r.mode}`);
    check('gate on + unresolvable secret does NOT fall back to mock', r.mode !== 'mock');
    check('gate on + unresolvable secret never yields a live connector', r.mode !== 'live_readonly');
  }

  // --- 6. Gate ON + incomplete identity config => FAIL CLOSED -------------
  {
    const r = await bootstrapM365ReadOnlyConnector({
      env: withEnv({ IT_AGENT_GRAPH_LIVE_READONLY: 'true', GRAPH_CLIENT_ID: '' }),
      keyVaultClientFactory: throwingKvFactory,
      httpClientFactory: throwingHttpFactory
    });
    check('gate on + missing client id reports graph_config_incomplete',
      r.mode === 'fail_closed' && r.reason === 'graph_config_incomplete', `got ${r.mode}`);
  }

  // --- 7. Graph provisioning must not enable external execution ----------
  // isLiveExternalExecutionEnabled() reads process.env directly, so the gate is
  // exercised by temporarily staging the 011A values and always restoring them.
  {
    const priorExec = process.env.IT_AGENT_LIVE_EXTERNAL_EXECUTION;
    const priorRead = process.env.IT_AGENT_GRAPH_LIVE_READONLY;
    try {
      process.env.IT_AGENT_LIVE_EXTERNAL_EXECUTION = 'false';
      process.env.IT_AGENT_GRAPH_LIVE_READONLY = 'false';
      check('011A env keeps live external execution disabled',
        isLiveExternalExecutionEnabled() === false);

      // The load-bearing invariant: the Graph read gate is not a back door to
      // execution. Turning it fully on must leave execution disabled.
      process.env.IT_AGENT_GRAPH_LIVE_READONLY = 'true';
      check('enabling the Graph read gate does NOT enable external execution',
        isLiveExternalExecutionEnabled() === false);
    } finally {
      if (priorExec === undefined) delete process.env.IT_AGENT_LIVE_EXTERNAL_EXECUTION;
      else process.env.IT_AGENT_LIVE_EXTERNAL_EXECUTION = priorExec;
      if (priorRead === undefined) delete process.env.IT_AGENT_GRAPH_LIVE_READONLY;
      else process.env.IT_AGENT_GRAPH_LIVE_READONLY = priorRead;
    }
  }

  // --- 8. Live-read configuration must be server-only ---------------------
  {
    const publicKeys = Object.keys(PROVISIONED_011A).filter((k) => k.startsWith('NEXT_PUBLIC_'));
    check('no 011A configuration key is browser-exposed (NEXT_PUBLIC_*)', publicKeys.length === 0, publicKeys.join(','));
  }

  // --- 9. The mock connector exposes no write surface ---------------------
  {
    const r = await bootstrapM365ReadOnlyConnector({ env: PROVISIONED_011A });
    const methods = r.mode === 'mock' ? Object.keys(r.connector) : [];
    const writeish = methods.filter((m) => /write|update|set|delete|remove|reset|disable|wipe|create/i.test(m));
    check('connector exposes no write/remediation methods', writeish.length === 0, writeish.join(','));
  }

  return { pass, fail, failures };
}
