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

// Hard ceiling on how long a single Graph HTTP request may run before it is
// aborted. Prevents a hung/slow-loris connection from blocking a request path
// indefinitely. Read-only GETs are cheap, so this is deliberately short.
export const GRAPH_REQUEST_TIMEOUT_MS = 10_000;

// ------------------------------------------------------------
// URL-safety helpers (pure; no network). These are the security boundary that
// prevents the app-only Bearer token from ever being sent to a non-Graph host —
// e.g. via a hostile @odata.nextLink in a tampered response.
// ------------------------------------------------------------
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// True only when `url` is an absolute URL whose origin exactly matches the
// configured Graph base origin. Used to gate nextLink following.
export function isSameGraphOrigin(url: string, graphBaseUrl: string): boolean {
  const a = originOf(url);
  const b = originOf(graphBaseUrl);
  return a !== null && b !== null && a === b;
}

// Resolve a connector-supplied path into a concrete URL that is GUARANTEED to
// target the configured Graph host. Relative paths (always beginning with '/')
// are prefixed with the versioned base. Absolute paths (only ever an
// @odata.nextLink from Graph) must match the Graph origin or this throws —
// the token is never attached to a foreign host.
export function resolveGraphUrl(path: string, graphBaseUrl: string): string {
  if (/^https?:\/\//i.test(path)) {
    if (!isSameGraphOrigin(path, graphBaseUrl)) {
      throw new Error('Refusing to issue a Graph request to a non-Graph host.');
    }
    return path;
  }
  // Relative Graph path; keep the versioned base segment intact.
  return `${graphBaseUrl}${path}`;
}

// Parse a Retry-After header value. Graph sends integer seconds for 429/503.
// HTTP-date form is intentionally not honored (returns undefined so the caller
// falls back to bounded backoff) to keep this deterministic and clock-free.
export function parseRetryAfterSeconds(headerValue: string | null | undefined): number | undefined {
  if (!headerValue) return undefined;
  const n = Number(headerValue.trim());
  if (Number.isFinite(n) && n >= 0) return n;
  return undefined;
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
  // GET a Graph path. Returns HTTP status + parsed JSON body, plus the parsed
  // Retry-After (seconds) when the server supplied one — so the retry layer can
  // honor server-directed backoff on 429/503.
  get(path: string, token: string): Promise<{ status: number; body: unknown; retryAfterSeconds?: number }>;
}

// Real client factory. NOTE: this is only invoked behind the live gate with a
// resolved secret. It is never called during tests/build/CI in this build.
export function createDefaultGraphHttpClient(config: GraphConfig, clientSecret: string): GraphHttpClient {
  const tokenUrl = `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`;
  // Run one fetch under a hard timeout with guaranteed cleanup. On abort the
  // underlying socket is torn down so a hung Graph/Azure endpoint cannot pin a
  // request path open. The error message never includes secrets or response bodies.
  async function fetchWithTimeout(input: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GRAPH_REQUEST_TIMEOUT_MS);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    async getToken(): Promise<string> {
      const params = new URLSearchParams({
        client_id: config.clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
        // .default => exactly the app's pre-consented (read-only) app permissions
        scope: 'https://graph.microsoft.com/.default'
      });
      const res = await fetchWithTimeout(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
      // Status only — never echo the token response body (it carries the token).
      if (!res.ok) throw new Error(`Graph token request failed: HTTP ${res.status}`);
      const json = (await res.json()) as { access_token?: string };
      if (!json.access_token) throw new Error('Graph token response missing access_token');
      return json.access_token;
    },
    async get(path: string, token: string): Promise<{ status: number; body: unknown; retryAfterSeconds?: number }> {
      // resolveGraphUrl throws if `path` is an absolute URL for any host other
      // than the configured Graph origin, so the Bearer token below is only ever
      // attached to a genuine Graph request. GET only — no write verbs exist here.
      const url = resolveGraphUrl(path, config.graphBaseUrl);
      const res = await fetchWithTimeout(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
      let body: unknown = null;
      try { body = await res.json(); } catch { body = null; }
      return { status: res.status, body, retryAfterSeconds: parseRetryAfterSeconds(res.headers.get('retry-after')) };
    }
  };
}
