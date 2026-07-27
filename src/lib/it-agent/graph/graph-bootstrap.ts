// ============================================================
// Watson — H&R AI IT Agent : Live read-only Graph bootstrap (SERVER-ONLY)
// ------------------------------------------------------------
// Assembles the production read-only Microsoft Graph connector from the
// existing pieces — validated config, Azure Key Vault SecretProvider, and
// the default Graph HTTP transport — reusing resolveM365ReadOnlyConnector.
// It returns a discriminated result (mock | live_readonly | fail_closed) and
// NEVER a partially initialized client.
//
// Invariants preserved:
//   * Mock is the default. Azure is NOT touched unless the live gate is on.
//   * Live requires IT_AGENT_GRAPH_LIVE_READONLY truthy + complete config +
//     a resolved secret + an assembled transport + a live connector.
//   * Any gap => fail_closed with a SAFE reason CODE (no config values).
//   * The graph live-read flag never enables general external execution.
//   * No Graph write capability anywhere.
// ============================================================
import type { GraphConfig, GraphHttpClient, KeyVaultSecretClient, SecretProvider } from './graph-config';
import {
  loadGraphConfig,
  isGraphLiveReadOnlyEnabled,
  createDefaultGraphHttpClient,
  createAzureKeyVaultSecretProvider
} from './graph-config';
import { resolveM365ReadOnlyConnector, type ResolvedConnector } from './graph-diagnostics';
import { mockReadOnlyConnector } from './graph-microsoft365';
import { createAzureManagedKeyVaultClient } from './azure-keyvault';

type KvClientFactory = (vaultUrl: string, env: NodeJS.ProcessEnv) => KeyVaultSecretClient | Promise<KeyVaultSecretClient>;
type HttpClientFactory = (config: GraphConfig, secret: string) => GraphHttpClient;

// Module-default factories point at the REAL Azure/Graph implementations. Tests
// override them via __setGraphLiveFactoriesForTests so no real SDK client is ever
// constructed and no network call is ever made. Production never overrides them.
let defaultKvFactory: KvClientFactory = createAzureManagedKeyVaultClient;
let defaultHttpFactory: HttpClientFactory = createDefaultGraphHttpClient;

export interface BootstrapOpts {
  env?: NodeJS.ProcessEnv;
  // Direct injection seams (bootstrap unit tests). When present these bypass the
  // Azure SDK entirely.
  secretProvider?: SecretProvider;
  http?: GraphHttpClient;
  keyVaultClientFactory?: KvClientFactory;
  httpClientFactory?: HttpClientFactory;
}

// Server-only test seam: swap the live Azure/Graph factories so the route path
// (which passes no factories) can be exercised without real Azure/network.
export function __setGraphLiveFactoriesForTests(o: { kv?: KvClientFactory; http?: HttpClientFactory }): void {
  if (o.kv) defaultKvFactory = o.kv;
  if (o.http) defaultHttpFactory = o.http;
}
export function __resetGraphLiveFactoriesForTests(): void {
  defaultKvFactory = createAzureManagedKeyVaultClient;
  defaultHttpFactory = createDefaultGraphHttpClient;
}

// Assemble the read-only connector for production. Reason codes are safe to
// surface to operators (no tenant/client IDs, vault URLs, secret refs, or values).
export async function bootstrapM365ReadOnlyConnector(opts: BootstrapOpts = {}): Promise<ResolvedConnector> {
  const env = opts.env ?? process.env;

  // Gate OFF => mock default. Azure SDK is never loaded or constructed here.
  if (!isGraphLiveReadOnlyEnabled(env)) {
    return { mode: 'mock', connector: mockReadOnlyConnector };
  }

  const config = loadGraphConfig(env);
  if (!config) return { mode: 'fail_closed', reason: 'graph_config_incomplete' };

  const httpClientFactory = opts.httpClientFactory ?? defaultHttpFactory;

  try {
    // A directly-injected transport (tests) bypasses secret/Azure resolution.
    if (opts.http) {
      const r = await resolveM365ReadOnlyConnector({ env, http: opts.http, httpClientFactory });
      return r.mode === 'fail_closed' ? { mode: 'fail_closed', reason: 'live_connector_unavailable' } : r;
    }

    // Build the SecretProvider: injected fake, or the real Azure Key Vault client.
    let secretProvider = opts.secretProvider;
    if (!secretProvider) {
      if (!config.keyVaultUrl) return { mode: 'fail_closed', reason: 'keyvault_not_configured' };
      const kvFactory = opts.keyVaultClientFactory ?? defaultKvFactory;
      const kvClient = await kvFactory(config.keyVaultUrl, env);
      secretProvider = createAzureKeyVaultSecretProvider({ keyVaultUrl: config.keyVaultUrl, client: kvClient });
    }

    const r = await resolveM365ReadOnlyConnector({ env, secretProvider, httpClientFactory });
    return r.mode === 'fail_closed' ? { mode: 'fail_closed', reason: 'live_connector_unavailable' } : r;
  } catch {
    // Azure identity/vault/transport construction failed. Fail closed with a safe
    // code; never surface the underlying Azure/Graph error.
    return { mode: 'fail_closed', reason: 'azure_bootstrap_error' };
  }
}

// Safe deployment-diagnostics view. Reports ONLY presence booleans — never any
// value, tenant/client ID, secret reference, vault URL, token, or secret.
export function graphLiveReadinessStatus(env: NodeJS.ProcessEnv = process.env) {
  const config = loadGraphConfig(env);
  const flag = isGraphLiveReadOnlyEnabled(env);
  const keyVaultConfigured = Boolean(env.AZURE_KEY_VAULT_URL?.trim());
  return {
    liveReadOnlyFlag: flag,
    graphConfigComplete: Boolean(config),
    tenantConfigured: Boolean(env.GRAPH_TENANT_ID?.trim()),
    clientConfigured: Boolean(env.GRAPH_CLIENT_ID?.trim()),
    secretRefConfigured: Boolean(env.GRAPH_CLIENT_SECRET_KEYVAULT_REF?.trim()),
    keyVaultConfigured,
    managedIdentitySelectorPresent: Boolean(env.AZURE_MANAGED_IDENTITY_CLIENT_ID?.trim()),
    // True only when the gate is on AND every required item is present. Does not
    // guarantee Azure/Graph reachability — only that a live attempt would proceed.
    liveReadWouldAttempt: flag && Boolean(config) && keyVaultConfigured
  };
}
