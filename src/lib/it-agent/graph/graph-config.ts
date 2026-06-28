// ============================================================
// Watson — H&R AI IT Agent : Microsoft Graph config + secrets
// ------------------------------------------------------------
// READ-ONLY Graph support, DISABLED BY DEFAULT. This module holds
// the configuration + secret-loading design only. It performs NO
// Azure / Graph network calls by itself. Secrets are NEVER read
// from source or committed env — only a Key Vault REFERENCE name
// is read from env; the secret VALUE is resolved at runtime via a
// SecretProvider (Azure Key Vault in production, an injected mock
// in tests). All paths fail closed when config/secret is missing.
// ============================================================

export interface GraphConfig {
  tenantId: string;
  clientId: string;
  // Key Vault secret NAME or URI reference — NOT the secret value.
  clientSecretRef: string;
  keyVaultUrl: string;
  graphBaseUrl: string;
  liveReadOnlyEnabled: boolean;
}

// Abstracts WHERE the Graph client secret/cert comes from.
// Production: Azure Key Vault. Tests: an injected in-memory provider.
export interface SecretProvider {
  readonly id: string;
  getSecret(ref: string): Promise<string | null>;
}

// Default provider is FAIL-CLOSED: it returns no secret and makes no
// Azure calls. Without an explicitly injected Key Vault provider, the
// live Graph connector therefore cannot initialize.
export const failClosedSecretProvider: SecretProvider = {
  id: 'fail-closed',
  async getSecret(): Promise<string | null> {
    return null;
  }
};

// Placeholder for the future real Azure Key Vault provider. It is NOT
// wired to the Azure SDK in this build (that is a later, separately
// reviewed slice) and fails closed so nothing can accidentally go live.
export function createAzureKeyVaultSecretProvider(_keyVaultUrl: string): SecretProvider {
  return {
    id: 'azure-key-vault (not-wired-in-this-build)',
    async getSecret(): Promise<string | null> {
      // Intentionally not implemented here: wiring @azure/identity +
      // @azure/keyvault-secrets is deferred to a dedicated, reviewed slice.
      // Fail closed until then.
      return null;
    }
  };
}

export function isGraphLiveReadOnlyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.IT_AGENT_GRAPH_LIVE_READONLY ?? 'false').toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

// Reads NON-SECRET config + references from env. The client secret itself is
// never read from env — only a Key Vault reference is. Returns null if any
// required field is missing (fail-closed).
export function loadGraphConfig(env: NodeJS.ProcessEnv = process.env): GraphConfig | null {
  const tenantId = env.GRAPH_TENANT_ID?.trim() ?? '';
  const clientId = env.GRAPH_CLIENT_ID?.trim() ?? '';
  const clientSecretRef = env.GRAPH_CLIENT_SECRET_KEYVAULT_REF?.trim() ?? '';
  const keyVaultUrl = env.AZURE_KEY_VAULT_URL?.trim() ?? '';
  const graphBaseUrl = env.GRAPH_BASE_URL?.trim() || 'https://graph.microsoft.com/v1.0';
  const liveReadOnlyEnabled = isGraphLiveReadOnlyEnabled(env);
  if (!tenantId || !clientId || !clientSecretRef) return null;
  return { tenantId, clientId, clientSecretRef, keyVaultUrl, graphBaseUrl, liveReadOnlyEnabled };
}

// HTTP abstraction so tests inject a fake client (no network whatsoever).
// The real implementation is only ever constructed when the live read-only
// gate is enabled AND a secret has been resolved from Key Vault.
export interface GraphHttpClient {
  // App-only (client-credentials) token using the app's READ-ONLY application
  // permissions (scope: <graph>/.default). No write scopes are ever requested.
  getToken(): Promise<string>;
  // GET a Graph path. Returns HTTP status + parsed JSON body.
  get(path: string, token: string): Promise<{ status: number; body: unknown }>;
}

// Real client factory. NOTE: this is only invoked behind the live gate with a
// resolved secret. It is never called during tests/build/CI in this build.
export function createDefaultGraphHttpClient(config: GraphConfig, clientSecret: string): GraphHttpClient {
  const tokenUrl = `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`;
  return {
    async getToken(): Promise<string> {
      const params = new URLSearchParams({
        client_id: config.clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
        // .default => exactly the app's pre-consented (read-only) app permissions
        scope: 'https://graph.microsoft.com/.default'
      });
      const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
      if (!res.ok) throw new Error(`Graph token request failed: HTTP ${res.status}`);
      const json = (await res.json()) as { access_token?: string };
      if (!json.access_token) throw new Error('Graph token response missing access_token');
      return json.access_token;
    },
    async get(path: string, token: string): Promise<{ status: number; body: unknown }> {
      const url = path.startsWith('http') ? path : `${config.graphBaseUrl}${path}`;
      // GET only — this client exposes no write verbs.
      const res = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
      let body: unknown = null;
      try { body = await res.json(); } catch { body = null; }
      return { status: res.status, body };
    }
  };
}
