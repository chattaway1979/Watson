# Watson — Managed-Identity Graph Credential (011B)

Task: **WATSON-MANAGED-IDENTITY-GRAPH-READINESS-011B**.

Adopts the Watson App Service **system-assigned managed identity** as the sole
Microsoft Graph runtime credential, replacing the client-credentials design
proposed in 011A.

Contains no tenant, subscription, client, object, or principal identifiers.

> **Amended by 011C.** `MailboxSettings.Read` was **removed** from the managed
> identity (Exchange Option C), so the approved set is now **two** roles:
> `User.Read.All` and `UserAuthenticationMethod.Read.All`. `check_mailbox_status`
> is unavailable by design. The obsolete `GRAPH-APP` registration referenced in
> §2 and §7 has been **deleted**. See `docs/GRAPH_LIVE_PILOT_011C.md`.

> **Live Graph reads remain DISABLED.** `IT_AGENT_GRAPH_LIVE_READONLY=false` and
> `IT_AGENT_LIVE_EXTERNAL_EXECUTION=false`. No employee or workload Graph data
> was queried by this task. 011C is **not** enabled.

---

## 1. Why managed identity

The 011A design required a client secret in Key Vault. Managed identity removes
the credential from the system entirely:

| | Client credentials (011A) | Managed identity (011B) |
|---|---|---|
| Secret to store | Yes — Key Vault | **None** |
| Rotation burden | Yes, expiring secret | **None** |
| Credential in config | Secret *reference* | **Nothing** |
| Exfiltration surface | Vault + config + token | **Token only, in-memory** |
| Failure mode if vault unreachable | Live reads break | **Not applicable** |

A credential that does not exist cannot leak, expire, or be committed.

## 2. Identity posture (Phase 1, redacted aliases)

| Alias | Identity | State |
|---|---|---|
| `MI-SP` | App Service system-assigned managed identity | **Now holds the 3 approved Graph app roles** |
| `GRAPH-APP` | 011A app-only app registration | **Obsolete.** 0 passwords, 0 certificates. Retains 3 consents; see §7 |
| `LOGIN-APP` | Easy Auth login app | **Unchanged** — delegated `openid profile email` only, **zero** Graph application roles |

Employee sign-in and app-only Graph access remain entirely separate identities.

## 3. Final Graph permission matrix

All **Application** permissions, all read-only, assigned **directly to `MI-SP`**:

| Permission | Endpoint | Why required |
|---|---|---|
| `User.Read.All` | `/users/{id}`, `/users/{id}/licenseDetails`, `/users/{id}/transitiveMemberOf` | Account state incl. `accountEnabled`; license SKUs; group membership |
| `UserAuthenticationMethod.Read.All` | `/users/{id}/authentication/methods` | MFA method presence/type. No narrower read exists |
| `MailboxSettings.Read` | `/users/{id}/mailboxSettings` | Mailbox settings only — never message content |

Verified on `MI-SP`: **3 roles, 0 write-capable, `Directory.Read.All` absent, no
`RoleManagement*`, no `DeviceManagement*`.**

### `GroupMember.Read.All` — REJECTED as redundant

Microsoft's reference for
[`GET /users/{id}/transitiveMemberOf`](https://learn.microsoft.com/en-us/graph/api/user-list-transitivememberof?view=graph-rest-1.0),
table *"Permissions for another user's memberships"*, states:

| Permission type | Least privileged | Higher privileged |
|---|---|---|
| Application | **`User.Read.All`** | `Directory.Read.All`, `Directory.ReadWrite.All`, `Group.Read.All`, `GroupMember.Read.All` |

`User.Read.All` is the **documented least-privileged** application permission for
the exact call Watson makes; `GroupMember.Read.All` is explicitly *higher
privileged*. It was therefore:

- **not** assigned to `MI-SP`, and
- **removed** from `GRAPH-APP`'s existing consent.

> **Residual risk to verify in 011C.** The same page warns that when an app
> queries a relationship returning a `directoryObject` collection and lacks
> permission to read that resource type, members are returned with **limited
> information** — `@odata.type` and `id` only, other properties `null`. Watson's
> call selects `displayName`. If `displayName` returns `null` under
> `User.Read.All` alone, `check_group_membership` needs a group-read permission
> after all. This cannot be settled without a live Graph call, which 011B
> forbids. **Verify first in 011C**; if names are null, add `GroupMember.Read.All`
> back for that single call and nothing else.

## 4. Credential implementation

`src/lib/it-agent/graph/graph-managed-identity.ts` (server-only):

- **`ManagedIdentityCredential` exclusively** — `DefaultAzureCredential` is
  deliberately **not** used. DefaultAzureCredential falls back to Azure CLI,
  environment, and developer credentials when no managed identity is present,
  which would let a developer identity silently impersonate the service.
  Restricting the chain makes that structurally impossible rather than a policy.
- Azure SDK is **lazily imported**, so it is never loaded in mock mode, tests, or
  build.
- Scope: `https://graph.microsoft.com/.default` — exactly the consented roles.
- **No client-secret fallback exists.** If the platform identity cannot mint a
  token, the transport throws and the connector fails closed.
- The token is never returned to a caller, logged, audited, serialized, or
  persisted. `extractGraphRoles()` reads **only** the `roles` claim and discards
  every other claim, including the token itself.

### Role posture without a Graph call

Granted roles are read from the **access token's own `roles` claim**, so the
permission check requires no `/users`, `/me`, `/groups`, or workload request. A
malformed or unreadable token yields no roles and fails closed.

### Five distinguishable readiness states

| State | Meaning |
|---|---|
| `live_gate_disabled` | Gate off — connector inactive. **Current state.** |
| `managed_identity_unavailable` | No platform identity to acquire a token with |
| `token_unavailable` | Identity present, token acquisition failed |
| `graph_permission_incomplete` | Token acquired, required roles missing/forbidden present |
| `credential_ready` | Token acquired and role posture satisfied |

Readiness never *claims* what it has not demonstrated: with the gate on but no
explicit probe, it reports `managed_identity_unavailable`.

## 5. Production bootstrap is now managed-identity

`bootstrapM365ReadOnlyConnector()` takes the managed-identity path whenever no
test injection seam is supplied — i.e. **always in production**. The legacy
client-credentials path survives only behind explicit injection seams so its
fail-closed behavior stays under test. There is no fallback between them.

## 6. Key Vault disposition

`watson-np-graph-kv` **remains, empty, with zero data-plane grants.**

- It is **not** part of the Graph credential path. `keyVaultRequiredForGraph` is
  reported as `false`, and an absent or empty vault cannot block Graph readiness.
- **No secret was invented to populate it**, and **no RBAC grant was created** to
  justify it. The two blocked role assignments from 011A are now moot for Graph.
- It is **reserved for future unrelated secrets only**. If no such requirement
  appears, deleting it is reasonable — but deletion is not authorized here, and
  purge protection means a 7-day non-purgeable window.

Legacy app settings `GRAPH_CLIENT_SECRET_KEYVAULT_REF` and `AZURE_KEY_VAULT_URL`
are **inert** under this model. They name a secret that does not exist. They are
harmless but should be removed in 011C for clarity.

## 7. Obsolete app registration — owner decision

`GRAPH-APP` is now unused. It holds **no credential**, so it cannot authenticate
and cannot read anything. It nonetheless retains three tenant-wide consents.

**Recommendation:** delete it in 011C. Removing an unused identity that carries
tenant-wide read consent is a straightforward privilege reduction. It was not
deleted here because deletion is destructive and was not authorized.

## 8. Actor-to-target isolation (Phase 8)

`src/lib/it-agent/graph/graph-actor-scope.ts`.

**The Graph credential is app-only: it can read every user in the tenant. Graph
provides no containment. Containment is enforced solely by Watson's policy
layer.** That makes this module, not the permission set, the real boundary.

| Control | Behavior |
|---|---|
| Subject derivation | Always from the verified session identity |
| Client-supplied target | **Refused** — even when it matches the caller |
| Employee targeting another employee | **Refused** as `cross_user_target`, **before** any Graph call |
| Existence oracle | Malformed and real foreign targets refused **identically** |
| Graph path / OData injection | Refused by the same rule; the identity regex rejects `/ \ ? # $ & : ; ' " < >` |
| Unknown / ambiguous identity | Fails closed (`identity_unmapped`) |
| Admin cross-user targeting | Out of scope on this path (`admin_targeting_out_of_scope`) |
| Case alignment | `caseSubjectAligned()` — case owner must equal subject |
| Audit | Reason **code** only; a refused target is never written to the audit trail |

`graphSubjectOrNull()` returns `null` for any refused decision, so a cross-user
Graph request is structurally unreachable rather than merely unreviewed.

## 9. Verification

- Deterministic tests: **375 → 431** (sections `[53]`, `[54]`, +56).
- `MI-SP` role posture verified directly against Entra after assignment.
- Live health endpoint re-checked: both gates `false`.

## 10. What remains for 011C

See the final section of `docs/GRAPH_PILOT_TEST_USERS_011A.md` and
`docs/EXCHANGE_MAILBOX_SCOPING_011B.md`. In short: live token acquisition in
App Service, pilot user selection, Exchange scoping, and the
`displayName`/`GroupMember.Read.All` verification in §3.
