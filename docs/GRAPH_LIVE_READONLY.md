# Watson — Live Read-Only Microsoft Graph (Operator Runbook)

> **SUPERSEDED IN PART BY 011B.** Watson's Graph credential is now the App
> Service **system-assigned managed identity**. There is no client secret, no
> certificate, and no Key Vault dependency. Sections 1, 4, 6 (secret/vault
> variables) and 8 below describe the retired client-credentials model and are
> kept only for history. For the current model, permission set, and readiness
> states see **`docs/GRAPH_MANAGED_IDENTITY_011B.md`**. Sections 9–12
> (fail-closed behavior, rollback, no-writes) remain accurate.

Watson's Microsoft 365 diagnostics are **read-only** and run against a **mock
connector by default**. Live Microsoft Graph reads are possible only when an
operator deliberately completes every item in the gate below. This document is
the configuration + controlled-test runbook. Nothing here enables any write,
remediation, or account change — Watson has **no Graph write capability**.

> Default posture: `IT_AGENT_GRAPH_LIVE_READONLY=false` → mock. With no Azure
> configuration the diagnostics route still works in mock mode.

---

## 1. Entra application registration

Register (or reuse) a single-tenant **Microsoft Entra ID app registration** that
Watson uses for **app-only (client-credentials)** Graph access:

- Create an App registration in the target tenant.
- Record its **Application (client) ID** → `GRAPH_CLIENT_ID`.
- Record the **Directory (tenant) ID** → `GRAPH_TENANT_ID`.
- Create a **client secret** for the app. **Do not** put the secret in env or
  source — store it in Azure Key Vault (section 4).

## 2. Microsoft Graph application permissions (least privilege)

Watson performs exactly five read-only calls. The corresponding **application**
(not delegated) permissions are:

| Diagnostic | Graph endpoint (GET) | Application permission |
|---|---|---|
| `lookup_user` | `/users/{id}` | `User.Read.All` |
| `check_license_status` | `/users/{id}/licenseDetails` | `User.Read.All` |
| `check_mfa_status` | `/users/{id}/authentication/methods` | `UserAuthenticationMethod.Read.All` |
| `check_mailbox_status` | `/users/{id}/mailboxSettings` | `MailboxSettings.Read` |
| `check_group_membership` | `/users/{id}/transitiveMemberOf` | `GroupMember.Read.All` (or `User.Read.All`) |

Grant **only** the permissions for the diagnostics you intend to enable. The
exact minimal set (e.g. whether `GroupMember.Read.All` vs `User.Read.All`
suffices for transitive membership, and any Entra ID licensing requirement for
authentication methods) **must be confirmed with the tenant admin during
review** — do not assume beyond this table. No `*.Write`/`*.ReadWrite`
permission is ever required or requested.

## 3. Admin consent

Application permissions require **tenant admin consent**. In the app
registration → **API permissions**, click **Grant admin consent** for the tenant
after adding the permissions above. Without admin consent, live reads return a
normalized `unavailable` result (never a fabricated success).

## 4. Azure Key Vault secret

The Graph client secret lives **only** in Key Vault; env holds a *reference*.

- Create/choose a Key Vault → its URL → `AZURE_KEY_VAULT_URL`
  (e.g. `https://my-vault.vault.azure.net`).
- Store the app's client secret as a Key Vault secret. Its **name** →
  `GRAPH_CLIENT_SECRET_KEYVAULT_REF` (e.g. `watson-graph-client-secret`).
- Grant the Watson host identity (section 5) **Key Vault Secrets User** (get
  secret) on this vault. No other access is needed.

## 5. Managed / workload identity

Watson resolves the Key Vault secret using `@azure/identity`
`DefaultAzureCredential` (managed identity in Azure hosting; no secrets on disk):

- **System-assigned managed identity** (default): enable it on the host and give
  it the vault access from section 4. Leave `AZURE_MANAGED_IDENTITY_CLIENT_ID`
  unset.
- **User-assigned managed identity / workload identity**: set
  `AZURE_MANAGED_IDENTITY_CLIENT_ID` to that identity's client ID (this is **not**
  `GRAPH_CLIENT_ID` and is **not** a secret).

## 6. Required server environment variables

| Variable | Purpose | Secret? |
|---|---|---|
| `IT_AGENT_GRAPH_LIVE_READONLY` | Master live-read flag (`true`/`1`/`yes` to enable) | no |
| `GRAPH_TENANT_ID` | Entra tenant (directory) ID | no |
| `GRAPH_CLIENT_ID` | Entra app (client) ID for Graph | no |
| `GRAPH_CLIENT_SECRET_KEYVAULT_REF` | Key Vault secret **name/reference** | no (reference only) |
| `AZURE_KEY_VAULT_URL` | Key Vault URL | no |
| `GRAPH_BASE_URL` | Optional; defaults to `https://graph.microsoft.com/v1.0` | no |
| `AZURE_MANAGED_IDENTITY_CLIENT_ID` | Optional user-assigned MI client ID | no |

The client secret **value** is never an environment variable. It is fetched at
runtime from Key Vault. `graphLiveReadinessStatus()` reports only presence
booleans for deployment diagnostics — never any value.

## 7. How to keep live reads DISABLED (default)

Leave `IT_AGENT_GRAPH_LIVE_READONLY` unset or `false`. The route serves **mock**
evidence. This is the default and requires no Azure configuration.

## 8. How to enable live reads deliberately

Complete sections 1–6, then set `IT_AGENT_GRAPH_LIVE_READONLY=true` and restart.
The bootstrap will attempt live only when **every** requirement is satisfied.

## 9. Expected behavior: mock / live_readonly / fail_closed

- **mock** — gate off (default), or gate malformed/false. Deterministic mock data.
- **live_readonly** — gate on **and** config complete **and** secret resolved
  from Key Vault **and** Graph transport assembled. Reads hit real Graph
  (read-only) and are normalized.
- **fail_closed** → route returns a normalized `not_configured` outcome with a
  safe reason code (`graph_config_incomplete`, `keyvault_not_configured`,
  `azure_bootstrap_error`, `live_connector_unavailable`). It **never** silently
  falls back to mock when the gate is on, and never exposes Azure/Graph internals.

## 10. Controlled tenant-test checklist

1. In a **non-production** tenant, complete sections 1–6.
2. Verify readiness booleans via `graphLiveReadinessStatus()` (all required
   `true`); confirm no values are printed.
3. Set `IT_AGENT_GRAPH_LIVE_READONLY=true`; restart.
4. As an **admin** actor, call `GET /api/it-agent/diagnostics/m365?read=lookup_user&target=<known-test-user>`.
5. Confirm the response `connector` is `live_readonly` and `result` is normalized
   (no raw Graph fields, no tokens/secrets).
6. Exercise each of the five reads against known test users.
7. Confirm the audit trail shows `diagnostic_read_performed` with **state only**
   (no secrets/payloads).
8. Confirm no approvals were created and no write/remediation occurred.

## 11. Rollback

Set `IT_AGENT_GRAPH_LIVE_READONLY=false` (or unset it) and restart. The route
immediately returns to mock. No other change is required; no state is mutated by
diagnostics, so there is nothing to undo.

## 12. No Graph writes

Watson's Graph connector exposes **only** GET read methods and requests only
read scopes (`.default` app permissions, which are the read permissions granted
in section 2). There is no write client, no write verb, and no remediation path
reachable from diagnostics. Approval, policy, and execution controls remain
authoritative and unchanged; live-read enablement does **not** enable general
external execution.
