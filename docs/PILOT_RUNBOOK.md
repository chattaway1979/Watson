# Watson — Controlled Pilot Runbook (Auth + Read-Only Graph)

This is the complete owner-assisted path from the current repository state to a
controlled, **read-only** live Microsoft 365 pilot. Watson stays **mock by
default**, has **no Graph write capability**, and performs **no remediation**.
Steps marked **[CLINT]** need Clint; **[AAD-ADMIN]** need a Microsoft/Azure
administrator. Nothing here is executed by the codebase automatically.

> Two independent gates protect production:
> 1. **Authentication** — `WATSON_AUTH_MODE=entra` + a platform auth gate.
> 2. **Live Graph reads** — `IT_AGENT_GRAPH_LIVE_READONLY=true` + full config.
> They are enabled in separate, change-controlled steps.

---

## Phase 0 — Concepts

- **Auth modes:** `demo` (dev/test only; role cookie/header) vs `entra`
  (production; verified Entra session only). No silent fallback.
- **Entra identity source:** Azure **App Service Authentication (Easy Auth)**
  authenticates every request and injects a verified `x-ms-client-principal`
  header (stripping any client-supplied copy). Watson maps that principal to its
  Actor and grants **admin** only via a configured group/app-role claim.
- **Alternative provider:** Auth.js/NextAuth with the Microsoft Entra ID provider
  can populate the same seam; Easy Auth is the zero-dependency default for Azure
  hosting and is assumed below.

## Phase 1 — Tenant & app registrations

1. **[AAD-ADMIN]** Select or create a **non-production** Entra tenant for the pilot.
2. **[AAD-ADMIN]** Create the **Watson login** app registration (for user sign-in
   via App Service Authentication). Record the client ID.
3. **[AAD-ADMIN]** Configure **redirect URIs** for the deployed hostname
   (App Service Authentication provides these, typically
   `https://<app-host>/.auth/login/aad/callback`).
4. **[AAD-ADMIN]** Create an **admin security group** (record its **object id**)
   **or** define an **app role** (e.g. value `Watson.Admin`) on the login app and
   assign the pilot admins. This becomes `WATSON_ADMIN_ENTRA_GROUP_ID` or
   `WATSON_ADMIN_APP_ROLE`. Ensure the group/roles claim is emitted in the token.
5. **[AAD-ADMIN]** Create the **Graph service** app registration (may be the same
   app or separate). Record tenant id + client id → `GRAPH_TENANT_ID` /
   `GRAPH_CLIENT_ID`.
6. **[AAD-ADMIN]** Add the **minimum read-only Graph application permissions** for
   the reads you will pilot (see `docs/GRAPH_LIVE_READONLY.md` §2):
   `User.Read.All`, `UserAuthenticationMethod.Read.All`, `MailboxSettings.Read`,
   `GroupMember.Read.All`. Confirm the minimal set during review — do not
   over-grant. **No write permissions.**
7. **[AAD-ADMIN]** **Grant admin consent** for the tenant.
8. **[AAD-ADMIN]** Create a **client secret** for the Graph app. Do **not** paste
   it into env or source.

## Phase 2 — Key Vault & identity

9. **[AAD-ADMIN]** Store the Graph client secret in **Azure Key Vault**. Record
   the vault URL → `AZURE_KEY_VAULT_URL` and the secret name →
   `GRAPH_CLIENT_SECRET_KEYVAULT_REF`.
10. **[AAD-ADMIN]** Give the Watson host **managed identity** the *Key Vault
    Secrets User* role on that vault (optionally set
    `AZURE_MANAGED_IDENTITY_CLIENT_ID` for a user-assigned identity).

## Phase 3 — Deployment environment (auth ON, live-read OFF)

11. **[CLINT]** Set deployment environment variables:
    - `WATSON_AUTH_MODE=entra`
    - `WATSON_ADMIN_ENTRA_GROUP_ID=<group-object-id>` **or** `WATSON_ADMIN_APP_ROLE=<role>`
    - `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET_KEYVAULT_REF`,
      `AZURE_KEY_VAULT_URL` (and optional `AZURE_MANAGED_IDENTITY_CLIENT_ID`)
    - **`IT_AGENT_GRAPH_LIVE_READONLY=false`** (keep live reads OFF for now)
    - `IT_AGENT_LIVE_EXTERNAL_EXECUTION=false`
12. **[CLINT]** Deploy behind **App Service Authentication** so every request is
    authenticated and `x-ms-client-principal` is platform-injected. Do **not**
    deploy `entra` mode without a platform auth gate.

**Which values are secrets / browser-forbidden / required-when:**
| Variable | Secret? | To browser? | Required |
|---|---|---|---|
| `WATSON_AUTH_MODE` | no | no | before production |
| `WATSON_ADMIN_ENTRA_GROUP_ID` / `WATSON_ADMIN_APP_ROLE` | no | no | before production (entra) |
| `GRAPH_TENANT_ID` / `GRAPH_CLIENT_ID` | no | no | before live read |
| `GRAPH_CLIENT_SECRET_KEYVAULT_REF` | no (reference) | no | before live read |
| `AZURE_KEY_VAULT_URL` | no | no | before live read |
| `AZURE_MANAGED_IDENTITY_CLIENT_ID` | no | no | optional |
| Graph **client secret value** | **YES** | **never** | in Key Vault only |
| `AUTH_SECRET` (if NextAuth) | **YES** | **never** | only if using NextAuth |
| `IT_AGENT_GRAPH_LIVE_READONLY` | no | no | to enable live read |

No secret value is ever an app env var or sent to the browser.

## Phase 4 — Verify authenticated MOCK mode

13. **[CLINT]** Verify:
    - **Sign-in** works through App Service Authentication.
    - **Admin authorization**: a member of the admin group/role reaches
      `/it-agent/diagnostics` and `GET /api/it-agent/diagnostics/m365/readiness`.
    - **Non-admin denial**: a signed-in non-admin gets 403 on the APIs and the
      "administrator required" page.
    - **Diagnostic UI in mock mode**: results are clearly labeled **MOCK DATA**.
    - **Readiness endpoint** reports `authMode: entra`, `connectorReadiness: mock`
      (gate still off), and value-free config booleans.

## Phase 5 — Enable live read (change-controlled)

14. **[CLINT]** Under change control, set `IT_AGENT_GRAPH_LIVE_READONLY=true`;
    restart. Confirm readiness now reports `ready_for_live`.
15. **[CLINT]** As an admin, run all five reads against **known pilot test
    accounts** via the UI or `GET /api/it-agent/diagnostics/m365?read=…&target=…`.
16. **[CLINT]** Confirm each response `connector: live_readonly`, normalized data
    only (no raw Graph JSON / tokens / secrets), and that the audit trail shows
    `diagnostic_read_performed` with **state only**.
17. **[CLINT]** Confirm **zero approvals**, **zero remediation**, **zero writes**.
18. **[CLINT]** Test **not-found** (unknown user → `not_found`) and
    **permission-denied** (a read whose consent is withheld → `unavailable` with a
    safe note) handling.
19. **[CLINT]** **Rollback proof**: set `IT_AGENT_GRAPH_LIVE_READONLY=false`;
    confirm the route returns to mock immediately. Nothing to undo — diagnostics
    mutate no state.
20. **[CLINT/AAD-ADMIN]** Record the **exact confirmed minimal permission set**
    that the pilot actually required.

## Phase 6 — Acceptance criteria & abort conditions

**Accept the pilot when all are true:**
- Entra sign-in + admin/non-admin authorization behave exactly as above.
- All five reads return normalized, correctly-stated live results for known users.
- Audit shows read events with no secrets/payloads; no approvals/writes occurred.
- Rollback (flag off → mock) verified.

**Abort / roll back immediately if any occur:**
- Any secret, token, tenant identifier, or raw Graph payload appears in a
  response, log, or audit entry.
- A non-admin obtains diagnostic access, or demo role headers are honored.
- Any write, approval, remediation, or state change is observed.
- Live reads occur while `IT_AGENT_GRAPH_LIVE_READONLY=false`.
- The connector returns fabricated "healthy" results for unavailable data.

## Points requiring Clint or an Azure/Microsoft administrator

- App registrations, redirect URIs, admin group/app-role, Graph permissions +
  **admin consent**, client secret, Key Vault + managed identity: **[AAD-ADMIN]**.
- Deployment env, deploying behind App Service Authentication, enabling/disabling
  the live-read flag, running the verification steps: **[CLINT]**.
