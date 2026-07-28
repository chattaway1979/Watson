# Watson — Live Graph Pilot Record (011C)

Task: **WATSON-MANAGED-IDENTITY-GRAPH-LIVE-PILOT-011C**.

Contains no tenant, subscription, client, object, or principal identifiers, and
no employee identity.

> **Status: PARTIAL.** Credential model, permission floor, cleanup and
> containment proofs are complete. The live pilot itself is blocked on
> owner-only steps in §7 — it cannot proceed without a selected pilot employee
> and an interactive sign-in.
>
> `IT_AGENT_GRAPH_LIVE_READONLY=false` and
> `IT_AGENT_LIVE_EXTERNAL_EXECUTION=false` throughout. No employee Graph data
> has been read.

---

## 1. Exchange decision record (Phase 3)

**Option C — remove `MailboxSettings.Read` — selected by the owner and executed.**

The role was removed from the managed identity rather than left granted
tenant-wide. Consequences, deliberately accepted:

- Watson holds **no mailbox permission of any kind**. The first pilot carries
  zero mailbox exposure.
- `check_mailbox_status` is **unavailable by design**, and reported as such —
  see §3.
- No Exchange Online PowerShell session, management scope, or permission-cache
  wait is required.
- Reversible: re-granting the role, or scoping it via Exchange Application RBAC
  (`docs/EXCHANGE_MAILBOX_SCOPING_011B.md`), remains available if a later pilot
  needs mailbox evidence.

## 2. Effective Graph permissions

| Permission | State |
|---|---|
| `User.Read.All` | **Granted** to the managed identity |
| `UserAuthenticationMethod.Read.All` | **Granted** to the managed identity |
| `MailboxSettings.Read` | **Removed** (Option C) |
| `GroupMember.Read.All` | **Absent** (011B — redundant) |
| `Directory.Read.All`, all write, device-management, role-management, Files.\*, Mail.\*, Teams.\*, Policy.\*, containment | **Absent** |

Verified after every change: **2 roles, 0 write-capable.**

## 3. Capability reflects effective permission, not intent

`effectiveGraphCapabilities()` derives what Watson can actually do from the roles
the credential really carries, via `GRAPH_READ_REQUIREMENTS`:

| Read | Requires | Status |
|---|---|---|
| `lookup_user` | `User.Read.All` | Available |
| `check_license_status` | `User.Read.All` | Available |
| `check_group_membership` | `User.Read.All` | Available |
| `check_mfa_status` | `UserAuthenticationMethod.Read.All` | Available |
| `check_mailbox_status` | `MailboxSettings.Read` | **Unavailable** |

This is the difference between reporting what we *meant* to grant and what is
actually true. Removing a role removes exactly the dependent read — covered by
deterministic tests.

## 4. Live credential verification endpoint (Phase 4)

`GET /api/it-agent/diagnostics/graph-credential` — **admin only**.

A managed identity exists only inside Azure, so the credential can only be
proven from the deployed runtime. This endpoint:

- acquires a token through the **production** provider
  (`ManagedIdentityCredential` only — no CLI, environment, developer, secret, or
  certificate fallback);
- makes **no Graph data call** — it talks solely to the Entra token service;
- is therefore safe to run while the live-read gate is **off**, which is exactly
  when it is needed;
- returns **only** derived booleans and Graph role names.

**The token never leaves the function.** Audience is reported as a *boolean*, not
a string, so no tenant-specific value can escape. Nothing is logged, audited, or
persisted. Validated: audience is Graph, token is application-only, no delegated
`scp` claim, roles match the approved set, no prohibited role.

## 5. Containment proof (Phase 6)

A request-counting transport proves refusal happens **before** any Graph request,
not after a discarded one. Every rejected case leaves the counter at **zero**:

| Rejected case | Graph calls |
|---|---|
| T4 submitted as explicit target | 0 |
| Own identifier submitted explicitly | 0 |
| Malformed target | 0 |
| OData / path injection | 0 |
| Unmapped identity | 0 |
| Unsupported administrator target | 0 |
| Unauthenticated | 0 |

All refusals share **one consistent error shape**, so responses cannot be used to
probe whether an address exists. The attempted identifier never reaches the audit
record. A positive control confirms authorized self-diagnosis *does* yield a
subject — so the zero-call result is containment, not an inert test.

## 6. Cleanup record (Phase 8)

**Deleted: the obsolete `GRAPH-APP` registration.** Preconditions verified first:
zero credentials, not the Easy Auth registration (confirmed against
`authsettingsV2`), no redirect URIs, zero source references, and its only
configuration reference removed beforehand. Deleting it also removed its three
tenant-wide Graph consents.

**Removed App Service settings:** `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`,
`GRAPH_CLIENT_SECRET_KEYVAULT_REF`, `AZURE_KEY_VAULT_URL`.

**`scripts/provision-graph-prereqs.sh` disabled.** It would have recreated the
deleted registration and re-consented tenant-wide permissions, silently undoing
this privilege reduction. It now refuses to run.

**Verified after cleanup:** `LOGIN-APP` unchanged (Easy Auth secret intact,
delegated `openid profile email`, zero Graph app roles); managed identity still
enabled with its two roles; `/api/health` 200 with both gates `false`.

**Key Vault `watson-np-graph-kv`: retained, empty, zero data-plane grants.** It
has **no** documented future Watson purpose. Recommendation: delete it. Not done
here — deleting an Azure resource requires explicit authorization, and purge
protection means a 7-day non-purgeable window.

## 7. Remaining owner-only actions

These cannot be completed from an automation session.

1. **Select T1 and T4** — `docs/GRAPH_PILOT_TEST_USERS_011A.md` §10. Per-user
   directory enumeration is refused by the automation environment, and every paid
   licence seat is consumed, so T1 must be an existing licensed employee.
2. **Verify the live credential.** Signed in as owner, open:
   `https://watson-pilot-hrnp01.azurewebsites.net/api/it-agent/diagnostics/graph-credential`
   Expect `tokenAcquired: true`, `audienceIsGraph: true`, `applicationOnly: true`,
   `hasDelegatedScopes: false`, `roles` exactly the two approved, and
   `capabilities.unavailable` containing `check_mailbox_status`.
3. **Resolve the `displayName` question (Phase 5)** — one narrowly scoped read
   for T1 only, after the gate is enabled. If group display names come back
   `null` under `User.Read.All` alone, **do not add a permission automatically**:
   bring the evidence back for an explicit decision. Never `Directory.Read.All`.
4. **Run the T1 live pilot and the T4 containment check** through an
   authenticated browser session.

## 8. Rollback

| Symptom | Action |
|---|---|
| Anything unexpected during the pilot | Set `IT_AGENT_GRAPH_LIVE_READONLY=false` and restart. Graph access stops immediately; the connector returns to mock. Nothing is mutated by reads, so there is nothing to undo. |
| Sign-in breaks | `LOGIN-APP` and Easy Auth were not modified by 011C. Redeploy the previous SHA. |
| Token acquisition fails after deploy | Connector fails closed — mock, never fabricated live. Confirm the managed identity is still enabled and holds both roles. |
| Roles differ from approved set | Stop. Do not enable the gate. Re-verify with the credential endpoint. |
| Need the old credential model back | Do **not** run the deprecated provisioning script. Re-provision deliberately and record why. |

## 9. Pilot readiness checklist

| # | Item | Status |
|---|---|---|
| 1 | Managed identity is the sole Graph credential | ✅ |
| 2 | No client secret / certificate / Key Vault dependency | ✅ |
| 3 | Approved minimum roles only, zero write-capable | ✅ |
| 4 | Effective capability reporting | ✅ |
| 5 | Live credential verification endpoint | ✅ deployed, ⏳ owner must run |
| 6 | Actor/target containment, zero Graph calls on refusal | ✅ |
| 7 | Obsolete credential artifacts removed | ✅ |
| 8 | Exchange posture deliberate and documented | ✅ Option C |
| 9 | Both gates false | ✅ |
| 10 | T1 / T4 selected | ⏳ owner |
| 11 | Live token proven from App Service runtime | ⏳ owner |
| 12 | `displayName` question resolved | ⏳ owner |
| 13 | T1 live read + T4 refusal proven end to end | ⏳ owner |
