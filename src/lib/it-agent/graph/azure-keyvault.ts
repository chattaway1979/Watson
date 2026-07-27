// ============================================================
// Watson — H&R AI IT Agent : Azure Key Vault adapter (SERVER-ONLY)
// ------------------------------------------------------------
// Narrow production adapter that satisfies the existing
// KeyVaultSecretClient interface using @azure/identity +
// @azure/keyvault-secrets. The Azure SDK is loaded LAZILY (dynamic
// import) and a client is constructed ONLY when this factory is
// actually invoked — i.e. only on the deliberate live-read path.
// It is never loaded or constructed during tests, build, or mock mode.
//
// This module handles WHERE credentials/clients come from. It resolves
// the client SECRET VALUE only through the existing SecretProvider
// contract (see createAzureKeyVaultSecretProvider); it never logs,
// serializes, audits, caches, or otherwise exposes secret values.
// ============================================================
import type { KeyVaultSecretClient } from './graph-config';

// Optional user-assigned managed-identity selector. Distinct from GRAPH_CLIENT_ID
// (which identifies the Entra app used for Microsoft Graph). When unset,
// DefaultAzureCredential uses its standard resolution (system-assigned managed
// identity / workload identity / environment) — appropriate for Azure hosting.
function managedIdentityClientId(env: NodeJS.ProcessEnv): string | undefined {
  const id = env.AZURE_MANAGED_IDENTITY_CLIENT_ID?.trim();
  return id ? id : undefined;
}

// Build a production Key Vault client bound to a managed-identity-capable
// credential. Async because it lazily imports the Azure SDK. The returned
// adapter maps SecretClient.getSecret(name) -> { value } and nothing else, so
// Azure SDK types never leak past this seam. Any construction failure (e.g. no
// identity available) propagates to the caller, which fails closed.
export async function createAzureManagedKeyVaultClient(
  vaultUrl: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<KeyVaultSecretClient> {
  const { DefaultAzureCredential } = await import('@azure/identity');
  const { SecretClient } = await import('@azure/keyvault-secrets');

  const miClientId = managedIdentityClientId(env);
  const credential = new DefaultAzureCredential(
    miClientId ? { managedIdentityClientId: miClientId } : undefined
  );
  const client = new SecretClient(vaultUrl, credential);

  return {
    async getSecret(name: string): Promise<{ value?: string | null } | null> {
      // Return only the value field through the narrow contract. The provider
      // (createAzureKeyVaultSecretProvider) enforces fail-closed on null/empty/
      // malformed and never exposes the value in logs, audit, or errors.
      const secret = await client.getSecret(name);
      return { value: secret?.value ?? null };
    }
  };
}
