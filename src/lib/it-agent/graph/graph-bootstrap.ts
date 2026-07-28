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
  loadManagedIdentityGraphConfig,
  isGraphLiveReadOnlyEnabled,
  createDefaultGraphHttpClient,
  createAzureKeyVaultSecretProvider
} from './graph-config';
import {
  createManagedIdentityTokenProvider,
  createManagedIdentityGraphHttpClient,
  validateGraphRolePosture,
  extractGraphRoles,
  graphManagedIdentityReadiness,
  type GraphTokenProvider
} from './graph-managed-identity';
import { resolveM365ReadOnlyConnector, type ResolvedConnector } from './graph-diagnostics';
import { mockReadOnlyConnector, createGraphConnector } from './graph-microsoft365';
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
  // Azure SDK entirely AND select the LEGACY client-credentials path, which now
  // exists only to keep its fail-closed behavior under test. Production passes
  // none of these and therefore always takes the managed-identity path below.
  secretProvider?: SecretProvider;
  http?: GraphHttpClient;
  keyVaultClientFactory?: KvClientFactory;
  httpClientFactory?: HttpClientFactory;
  // Managed-identity seam (011B). Tests inject a fake token provider; production
  // omits it and gets ManagedIdentityCredential.
  tokenProvider?: GraphTokenProvider;
}

// Server-only test seam: swap the live Azure/Graph factories so the route path
// (which passes no factories) can be exercised without real Azure/network.
// True while a test has overridden the module-level Azure factories. Production
// never sets it. It selects the legacy client-credentials path so the existing
// route-level live tests keep exercising that path rather than managed identity.
let legacyFactoriesOverridden = false;

export function __setGraphLiveFactoriesForTests(o: { kv?: KvClientFactory; http?: HttpClientFactory }): void {
  if (o.kv) defaultKvFactory = o.kv;
  if (o.http) defaultHttpFactory = o.http;
  legacyFactoriesOverridden = true;
}
export function __resetGraphLiveFactoriesForTests(): void {
  defaultKvFactory = createAzureManagedKeyVaultClient;
  defaultHttpFactory = createDefaultGraphHttpClient;
  legacyFactoriesOverridden = false;
}

// Assemble the read-only connector for production. Reason codes are safe to
// surface to operators (no tenant/client IDs, vault URLs, secret refs, or values).
export async function bootstrapM365ReadOnlyConnector(opts: BootstrapOpts = {}): Promise<ResolvedConnector> {
  const env = opts.env ?? process.env;

  // Gate OFF => mock default. Azure SDK is never loaded or constructed here.
  if (!isGraphLiveReadOnlyEnabled(env)) {
    return { mode: 'mock', connector: mockReadOnlyConnector };
  }

  // ---- Managed-identity path (011B): the production credential ----------
  // Selected whenever no legacy injection seam is supplied — i.e. always in
  // production. There is NO client secret, NO certificate, and NO Key Vault
  // dependency here, and deliberately no fallback to the legacy path: if the
  // platform identity cannot produce a usable token, the connector fails closed.
  const usingLegacySeams =
    Boolean(opts.http || opts.secretProvider || opts.keyVaultClientFactory) || legacyFactoriesOverridden;
  if (!usingLegacySeams) {
    try {
      const miConfig = loadManagedIdentityGraphConfig(env);
      const tokenProvider = opts.tokenProvider ?? createManagedIdentityTokenProvider(env);
      const token = await tokenProvider.getToken();
      if (!token) return { mode: 'fail_closed', reason: 'managed_identity_unavailable' };

      // Role posture is read from the token's own claims — no Graph data call.
      const posture = validateGraphRolePosture(extractGraphRoles(token));
      if (!posture.ok) return { mode: 'fail_closed', reason: 'graph_permission_incomplete' };

      const http = createManagedIdentityGraphHttpClient(miConfig, tokenProvider);
      const connector = createGraphConnector(miConfig, http);
      if (connector.mode !== 'live_readonly') {
        return { mode: 'fail_closed', reason: 'live_connector_unavailable' };
      }
      return { mode: 'live_readonly', connector };
    } catch {
      return { mode: 'fail_closed', reason: 'managed_identity_bootstrap_error' };
    }
  }

  // ---- Legacy client-credentials path (tests only) ----------------------
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
    //
    // NOTE (011B): this reflects the LEGACY client-credentials readiness and is
    // retained for continuity of the existing deployment view. The production
    // credential is now the managed identity, whose readiness is reported by
    // `managedIdentity` below and does NOT depend on Key Vault.
    liveReadWouldAttempt: flag && Boolean(config) && keyVaultConfigured,
    // Managed-identity model (011B) — the authoritative production credential.
    // Key Vault plays no part in it, so an absent or empty vault cannot block it.
    // Kept strictly boolean so this view remains presence-only; the role list and
    // any offending key names are available from graphManagedIdentityReadiness().
    credentialModelIsManagedIdentity: true,
    keyVaultRequiredForGraph: false,
    clientSecretPostureOk: graphManagedIdentityReadiness(env).clientSecretPostureOk,
    userAssignedIdentitySelected: Boolean(env.AZURE_MANAGED_IDENTITY_CLIENT_ID?.trim())
  };
}
