# Watson — Microsoft Graph READ-ONLY Connector

Slice: **WATSON-GRAPH-READONLY-001**. This adds a *real*, read-only Microsoft Graph
connector behind a shared read-only interface, **without** enabling live execution,
tenant writes, deployment, or any external write behavior. Mock remains the default.

## TL;DR safety posture
- **Read-only only.** The connector uses HTTP `GET` + a client-credentials token. There
  are **no write verbs** anywhere in `graph/`. No write scopes are requested.
- **Disabled by default.** `createGraphConnector()` **fails closed** — it throws unless
  the explicit gate `IT_AGENT_GRAPH_LIVE_READONLY=true` is set **and** required config is
  present. The provider factory `getM365ReadOnlyConnector()` returns the **mock** unless a
  real HTTP client is also supplied.
- **Separate from the execution gate.** Read-only Graph ≠ live IT execution. The write/
  execution master switch `IT_AGENT_LIVE_EXTERNAL_EXECUTION` is untouched and stays `false`.
- **No secrets in source/env/logs.** Only a Key Vault *reference* is read from env; the
  secret value is resolved at runtime via a `SecretProvider` (Azure Key Vault in prod, an
  injected fake in tests). Tokens/secrets are never logged or written to the audit trail.
- **CI/tests make zero live calls.** Every Graph test injects a fake HTTP client; the
  default path is mock.

## Files
| File | Purpose |
|------|---------|
| `src/lib/it-agent/graph/graph-config.ts` | `GraphConfig`, `SecretProvider` (Key Vault adapter, fail-closed), `loadGraphConfig`, `isGraphLiveReadOnlyEnabled`, `GraphHttpClient` + real client factory (only built behind the gate). |
| `src/lib/it-agent/graph/graph-microsoft365.ts` | `M365ReadOnlyConnector` (async, same normalized shapes), real `createGraphConnector` (fail-closed, read-only), `mockReadOnlyConnector` (default), `getM365ReadOnlyConnector` provider selection, `readonlyConnectorStatus`. |
| `scripts/graph-readonly.selftest.ts` | 17 deterministic tests (no network). |

The existing **synchronous** `M365Connector` + mock + tool-gateway path are unchanged, so
all prior guardrails are preserved. The Graph work is purely additive and isolated.

## How the mock stays the default
`getM365ReadOnlyConnector({ env })` returns `mockReadOnlyConnector` unless **all** hold:
`loadGraphConfig(env)` is non-null, `config.liveReadOnlyEnabled === true`, **and** an
`http` client is passed. In local dev / test / CI none of these are set, so it is always
mock. The mock returns the same normalized shapes via an async adapter over the existing
deterministic mock data.

## How to enable the Graph read-only connector later (production)
1. Register an Entra ID **app registration** with the read-only application permissions below
   and grant admin consent.
2. Store the client secret (or certificate) in **Azure Key Vault**. Do **not** put it in env.
3. Set non-secret config: `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_BASE_URL`,
   `AZURE_KEY_VAULT_URL`, and `GRAPH_CLIENT_SECRET_KEYVAULT_REF` (the secret's *name/URI*).
4. Set the gate `IT_AGENT_GRAPH_LIVE_READONLY=true`.
5. In the app bootstrap (a future, separately reviewed slice): implement the real
   `SecretProvider` against Key Vault (`@azure/identity` + `@azure/keyvault-secrets`),
   resolve the secret, build `createDefaultGraphHttpClient(config, secret)`, and pass it to
   `getM365ReadOnlyConnector({ http })`. Until that bootstrap exists, the connector fails
   closed to mock.

## Required Azure Key Vault secrets / config
| Item | Where | Secret? |
|------|-------|---------|
| Client secret (or certificate) | **Azure Key Vault** (referenced by name/URI) | **Yes — vault only** |
| `GRAPH_CLIENT_SECRET_KEYVAULT_REF` | env (reference name only) | No (a pointer) |
| `AZURE_KEY_VAULT_URL` | env | No |
| `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID` | env | No (identifiers) |
| `GRAPH_BASE_URL` | env (default `https://graph.microsoft.com/v1.0`) | No |

## Required Microsoft Graph permissions (least-privilege, READ-ONLY, application)
| Capability | Graph endpoint | Application permission (read-only) |
|------------|----------------|------------------------------------|
| lookup_user | `GET /users/{id}` | `User.Read.All` |
| check_license | `GET /users/{id}/licenseDetails` | `User.Read.All` |
| check_group_membership | `GET /users/{id}/transitiveMemberOf` | `GroupMember.Read.All` (or `Directory.Read.All`) |
| check_mfa | `GET /users/{id}/authentication/methods` | `UserAuthenticationMethod.Read.All` |
| mailbox_status | `GET /users/{id}/mailboxSettings` | `MailboxSettings.Read` |

**No write scopes are requested anywhere.** The client-credentials flow uses
`https://graph.microsoft.com/.default`, which grants exactly the app's pre-consented
(read-only) permissions and nothing more.

## Known limitations (honest fail-soft, never fabricated success)
- **MFA (`check_mfa`)**: requires `UserAuthenticationMethod.Read.All`; richer registration
  posture (the reporting API) also depends on **Entra ID P1/P2** licensing and Conditional
  Access visibility. On `401/403` or licensing limits the connector returns
  `state: 'unavailable'` (data `null`) — it never reports a false MFA status.
- **Mailbox (`mailbox_status`)**: mailbox **size and quota are not available via read-only
  Graph** (they require Exchange Online reporting/PowerShell). The connector returns
  `state: 'unavailable'` with `mailboxSizeGb: null` / `mailboxQuotaGb: null` and a best-effort
  `mailboxType`. Results can also be limited by tenant licensing and Conditional Access.
- General: results may be limited by tenant licensing, Conditional Access policies, the
  Entra ID plan, and Graph endpoint availability. The connector degrades to
  `unknown` / `unavailable` rather than guessing.

## Why this slice does NOT enable live execution or tenant writes
The objective was strictly a read-only seam. Enabling writes/execution would require the
write/execution master gate, approval-routed write actions, and a separately reviewed
security process. None of that is touched here: `IT_AGENT_LIVE_EXTERNAL_EXECUTION` stays
`false`, approval/audit gates are unchanged, and no write scopes/verbs exist in the code.

## How to validate safely (no production tenant changes)
- `npm run it-agent:selftest` — section **[11]** exercises the connector with an injected
  fake HTTP client: mock-default, fail-closed gate/config, response mapping, fail-soft
  unknown/unavailable, and secret/token non-logging. **No network, no tenant access.**
- `npx tsc --noEmit`, `npm run build`, `npm run lint`, `npm audit --audit-level=high` all
  pass with no live calls.
- To smoke-test against a **non-production** tenant later, set the env + Key Vault wiring in
  a sandbox tenant only, keep `IT_AGENT_LIVE_EXTERNAL_EXECUTION=false`, and confirm each
  method returns normalized read-only data. Never point it at production during validation.
