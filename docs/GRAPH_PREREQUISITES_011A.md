# Watson — Graph Prerequisites Provisioning Record (011A)

Task: **WATSON-GRAPH-PREREQUISITES-PROVISION-011A**

Non-secret record of the Microsoft Graph **prerequisite** provisioning. Contains
**no** secrets, tokens, tenant IDs, or client IDs — identifiers live only in
Azure platform configuration, per the convention in
`docs/PILOT_DEPLOYMENT_RECORD.md`.

> **Live Graph reads were NOT enabled by this task.**
> `IT_AGENT_GRAPH_LIVE_READONLY=false` and
> `IT_AGENT_LIVE_EXTERNAL_EXECUTION=false` throughout. The connector still
> resolves to **mock**. No Graph read, write, or remediation has occurred.

This task provisions items 1–6 of `docs/GRAPH_LIVE_READONLY.md`. It deliberately
stops short of section 8 ("enable live reads deliberately").

---

## 1. Scope decision

Two choices were made explicitly before any tenant change:

- **Execution scope:** full provisioning *including* tenant admin consent.
- **Permission set:** all four application permissions backing the five
  diagnostics (see §3).

## 2. Identity separation

A **new, dedicated app registration** was created for app-only Graph access. It
is **separate** from the existing Easy Auth login app (`Watson Non-Production`),
which remains delegated-only with **zero** Graph application permissions.

| Item | Value |
|---|---|
| Display name | **Watson Graph Read-Only (Non-Production)** |
| Sign-in audience | `AzureADMyOrg` (single tenant) |
| Redirect URIs | **none** (app-only; no interactive sign-in) |
| Credentials on the app | **none at time of writing** — see §7 |

Employee sign-in and app-only Graph reads therefore never share an identity.

## 3. Graph application permissions (read-only)

Granted as **application** roles with tenant admin consent. Permission IDs were
resolved from the tenant's Graph service principal rather than hardcoded.

| Permission | Backs diagnostic |
|---|---|
| `User.Read.All` | `lookup_user`, `check_license_status` |
| `GroupMember.Read.All` | `check_group_membership` |
| `UserAuthenticationMethod.Read.All` | `check_mfa_status` |
| `MailboxSettings.Read` | `check_mailbox_status` |

No `*.Write` / `*.ReadWrite` permission was requested or granted. Verified: the
service principal holds exactly these four app role assignments.

> **Sensitivity note.** `UserAuthenticationMethod.Read.All` and
> `MailboxSettings.Read` authorize reading **every** user's authentication
> methods and mailbox settings tenant-wide. The grant is real and effective now,
> even though Watson cannot use it while the live gate is off.

## 4. Tenant caveat (deviation from the runbook)

`docs/GRAPH_LIVE_READONLY.md` §10 prescribes a **non-production tenant** for the
controlled test. H&R Electric operates a **single** tenant; "non-production" here
is a resource-group and naming boundary (`watson-nonprod-rg`), not a directory
boundary. The app registration and its admin consent are therefore real objects
in the production directory. This is a deliberate, recorded deviation.

## 5. Key Vault

| Item | Value |
|---|---|
| Vault | `watson-np-graph-kv` |
| Resource group | `watson-nonprod-rg` |
| Region | South Central US |
| Authorization | **RBAC** (`enableRbacAuthorization=true`), not access policies |
| Soft delete retention | 7 days |
| Purge protection | **enabled** |
| Secret name (reference only) | `watson-graph-client-secret` |

> **Purge protection is irreversible.** It cannot be disabled once enabled. If
> the vault is deleted it remains recoverable — and un-purgeable — for 7 days.
> This was chosen as the safer default for a vault holding a Graph credential;
> note it affects teardown timelines.

## 6. Managed identity

A **system-assigned** managed identity was enabled on `watson-pilot-hrnp01`
(previously it had none). `AZURE_MANAGED_IDENTITY_CLIENT_ID` is intentionally
left unset, so `DefaultAzureCredential` uses the system-assigned identity.

**Why system-assigned rather than user-assigned:**

- Exactly **one** compute resource needs the identity. User-assigned exists to
  share one identity across several resources or to pre-create an identity
  before the resource; neither applies.
- Its lifecycle is bound to the web app, so deleting the app removes the
  identity and its role assignments — no orphaned principal accumulating grants.
- It requires no extra resource, no extra configuration value, and no
  `AZURE_MANAGED_IDENTITY_CLIENT_ID` in app settings — one less identifier in
  configuration.

Revisit only if Watson later runs across multiple resources (e.g. a worker plus
the web app) that must share one vault grant.

## 7. Client secret — deliberately NOT created

**No client secret exists.** The app registration has zero credentials, verified
programmatically. Two independent reasons:

1. **Least privilege / secret avoidance.** A credential that is never created
   cannot leak, cannot be committed, and never needs rotation. A secret should
   only exist if managed identity cannot do the job.
2. **The write path was blocked.** The role assignment needed to store it in the
   vault was refused by the automation environment (§8). Generating a secret
   with nowhere safe to put it would have forced it into a shell variable or
   onto disk — unacceptable.

### Architectural finding for 011B: the secret may be unnecessary entirely

Watson's connector currently authenticates to Graph with **client credentials** —
`createDefaultGraphHttpClient()` posts `client_id` + `client_secret` to the token
endpoint (`graph-config.ts`). That design is what makes a Key Vault secret
necessary at all.

A **managed-identity-direct** model would remove the secret from the system:

- Assign the four Graph application permissions to the **web app's managed
  identity** service principal instead of to a separate app registration.
- Acquire the Graph token via `DefaultAzureCredential` with scope
  `https://graph.microsoft.com/.default`.
- **Result:** no client secret, no Key Vault dependency for Graph, no rotation,
  and no credential that can be exfiltrated from configuration.

This is strictly more secure than the current design. It requires a change to
`getToken()` and is therefore **out of scope for 011A**, which must not implement
the live connector. It is recorded here as the recommended first decision of
**011B**. The Key Vault provisioned in §5 remains available and harmless either
way — no secret was invented merely to populate it.

## 8. Remaining steps — BLOCKED, require owner action

Two role assignments were **refused by the automation environment's permission
classifier**. Nothing was worked around.

| # | Step | Status |
|---|---|---|
| 1 | Grant the **operator** `Key Vault Secrets Officer` on `watson-np-graph-kv` | Blocked. Subscription `Owner` does **not** confer Key Vault data-plane access under RBAC, so no identity can currently read or write vault secrets. |
| 2 | Grant the web app managed identity `Key Vault Secrets User` on the vault | Blocked. This is `docs/GRAPH_LIVE_READONLY.md` §4/§5. |
| 3 | Create the client secret and store it in the vault | **Not attempted by design** — see §7. Resolve the §7 architecture decision first; under the managed-identity-direct model this step disappears. |

Until these are resolved, a live attempt fails **closed** with
`keyvault_not_configured` / `live_connector_unavailable` — never a silent
fallback to mock, never a fabricated success. This is covered by regression
tests in `scripts/graph-prereq-posture.selftest.ts`.

`scripts/provision-graph-prereqs.sh` is idempotent and contains all three steps;
re-running it once the role assignments are permitted completes the
client-credentials variant. Note the CLI caveat in §10.

## 9. Verification

`npm run verify:config` with the provisioned values and the gate off:

```
authMode:               entra
liveReadGateEnabled:    false
liveExecutionEnabled:   false
connectorReadiness:     mock
m365 config presence:   {"tenantConfigured":true,"clientConfigured":true,
                         "secretRefConfigured":true,"keyVaultConfigured":true,
                         "graphConfigComplete":true,
                         "managedIdentitySelectorPresent":false}
reasonCodes:            live_read_gate_disabled
healthy:                true
```

Config is **complete** and the connector still resolves to **mock** — which is
the whole point of this task: prerequisites in place, gate untouched.

App Service settings verified after the change:

```
GRAPH_TENANT_ID                   (set)
GRAPH_CLIENT_ID                   (set)
GRAPH_CLIENT_SECRET_KEYVAULT_REF  watson-graph-client-secret
AZURE_KEY_VAULT_URL               https://watson-np-graph-kv.vault.azure.net
IT_AGENT_GRAPH_LIVE_READONLY      false
IT_AGENT_LIVE_EXTERNAL_EXECUTION  false
```

Setting these supersedes the line in `docs/PILOT_DEPLOYMENT_RECORD.md` that read
"No Graph/Key Vault app settings"; the safety flags there are unchanged.

### Regression coverage

`scripts/graph-prereq-posture.selftest.ts` (section `[52]`) adds **20**
deterministic tests pinning the new provisioned-but-disabled posture: complete
config still resolves to mock, readiness never implies liveness, every partial
gap fails closed rather than degrading to mock, readiness leaks no values, the
Graph gate does not enable external execution, no config key is browser-exposed,
and the connector has no write surface. Suite total: **355 → 375**.

### Companion documents

| Document | Covers |
|---|---|
| `docs/GRAPH_PERMISSION_MATRIX_011A.md` | Least-privilege permission analysis, rejected/deferred permissions, further narrowing |
| `docs/GRAPH_PILOT_TEST_USERS_011A.md` | Test-user plan, actor-vs-target matrix, privacy controls, cleanup |
| `docs/GRAPH_LIVE_READONLY.md` | The operator runbook this task provisions against |

## 10. Environment caveat

Every `az role ...` subcommand fails in this environment with
`MissingSubscription`, including read-only calls, on Azure CLI 2.87.0. This is a
**CLI defect, not a permissions problem** — the equivalent ARM REST calls
succeed. Use the REST form (as the script does) or the portal.

## 11. Rollback

Rollback is clean because no live read was ever enabled and no state was mutated.

- **Remove consent + identity:** delete the `Watson Graph Read-Only
  (Non-Production)` app registration (removes its service principal and all four
  app role assignments).
- **Remove config:** delete the `GRAPH_*` and `AZURE_KEY_VAULT_URL` app settings
  from `watson-pilot-hrnp01`. Leave both safety flags at `false`.
- **Remove the identity binding:** `az webapp identity remove -g watson-nonprod-rg -n watson-pilot-hrnp01`.
- **Remove the vault:** delete `watson-np-graph-kv` — recoverable for 7 days and
  **not purgeable** in that window (see §5).

Reverting any of the above returns the deployment to its 010C posture. The
`IT_AGENT_GRAPH_LIVE_READONLY=false` default means nothing changes behaviorally
either way.
