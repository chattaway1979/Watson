# Watson — Microsoft Graph Least-Privilege Permission Matrix (011A)

Task: **WATSON-GRAPH-PREREQUISITES-PROVISION-011A**, Phase 2.

Derived from the **actual** endpoints in `src/lib/it-agent/graph/graph-microsoft365.ts`
(not from intent). All five diagnostics are `GET` only. No permission below
authorizes any write, and no write permission was requested or granted.

Contains no tenant, subscription, client, or object identifiers.

---

## 1. Endpoints Watson actually calls

The connector already minimizes returned data with `$select` on every call that
supports it:

| Read key | Graph request (GET only) |
|---|---|
| `lookup_user` | `/users/{id}?$select=id,displayName,userPrincipalName,mail,jobTitle,department,accountEnabled` |
| `check_license_status` | `/users/{id}/licenseDetails?$select=skuPartNumber` |
| `check_mfa_status` | `/users/{id}/authentication/methods` |
| `check_mailbox_status` | `/users/{id}/mailboxSettings` |
| `check_group_membership` | `/users/{id}/transitiveMemberOf/microsoft.graph.group?$select=displayName` |

## 2. Permission matrix

### `User.Read.All` — **Application** — required for first pilot

| Field | Value |
|---|---|
| Workload | Microsoft Entra ID (directory) |
| Watson use case | `lookup_user` **and** `check_license_status` |
| Data exposed | Full user profile for any user in the directory; license SKU assignments |
| Admin consent | **Required** |
| Narrower option rejected | `User.ReadBasic.All` (exists as an app role in this tenant) |
| Why narrower is insufficient | The basic profile set excludes **`accountEnabled`** and **`department`**, both of which `lookup_user` selects. `accountEnabled` is the single most diagnostic field for "why can't this employee sign in" — a disabled account is a primary IT root cause. Without it the diagnostic cannot distinguish "disabled" from "healthy". |
| Also covers | `/users/{id}/licenseDetails` — so **no separate license permission is needed**. |

### `UserAuthenticationMethod.Read.All` — **Application** — required for first pilot

| Field | Value |
|---|---|
| Workload | Entra ID authentication methods |
| Watson use case | `check_mfa_status` |
| Data exposed | Which authentication methods each user has registered (method *types*, not secrets, codes, or seeds) |
| Admin consent | **Required** |
| Narrower option rejected | `UserAuthenticationMethod.ReadWrite.All` — **write; rejected outright** (it permits resetting/deleting a user's MFA methods, an account-takeover primitive) |
| Why narrower is insufficient | Graph exposes no read-only permission below this one for `/authentication/methods`. There is no per-user or group-scoped variant. |
| Sensitivity | **High.** Tenant-wide visibility into every user's MFA posture. |

### `MailboxSettings.Read` — **Application** — required for first pilot

| Field | Value |
|---|---|
| Workload | Exchange Online |
| Watson use case | `check_mailbox_status` |
| Data exposed | Mailbox settings: time zone, language, automatic-replies state, working hours. **Not** message content. |
| Admin consent | **Required** |
| Narrower option rejected | `MailboxSettings.ReadWrite` — write; rejected |
| Why narrower is insufficient | This is already the workload-specific read permission; it is *not* directory-wide, satisfying the "prefer workload-specific" rule. |
| Further narrowing available | **Yes — see §4.** An Exchange **application access policy** can restrict this app to a named mail-enabled security group, converting tenant-wide mailbox access into group-scoped access. Recommended for 011B. |

### `GroupMember.Read.All` — **Application** — granted, but **redundancy flagged**

| Field | Value |
|---|---|
| Workload | Entra ID (groups) |
| Watson use case | `check_group_membership` |
| Data exposed | Group membership (display names only, via `$select`) |
| Admin consent | **Required** |
| Status | **Possibly redundant.** Microsoft Graph authorizes `GET /users/{id}/transitiveMemberOf` under **any** of `GroupMember.Read.All`, `User.Read.All`, or `Directory.Read.All`. Because `User.Read.All` is independently required (above), this permission may add no capability. |
| Recommendation | **Do not remove it blind.** Confirming redundancy requires an actual Graph call, which this task prohibits. Verify empirically in 011B: temporarily revoke, exercise `check_group_membership`, and keep it revoked if the read still succeeds. This is a privilege *reduction* with a small functional risk, so it belongs in a phase where it can be tested. |

## 3. Permissions explicitly rejected or deferred

None of the following were requested, and none should be added for the pilot:

| Category | Example permissions | Disposition |
|---|---|---|
| Directory-wide catch-all | `Directory.Read.All` | **Rejected** — strictly broader than the four above with no added diagnostic value |
| User modification / password reset | `User.ReadWrite.All`, `UserAuthenticationMethod.ReadWrite.All`, `Directory.ReadWrite.All` | **Rejected** — write |
| Device management | `DeviceManagementManagedDevices.ReadWrite.All`, `DeviceManagementManagedDevices.PrivilegedOperations.All` | **Rejected** — enables wipe / retire / lock / restart |
| Device read | `DeviceManagementManagedDevices.Read.All` | **Deferred** — Watson has no Intune diagnostic implemented; adding it now would be speculative |
| Group modification | `GroupMember.ReadWrite.All`, `Group.ReadWrite.All` | **Rejected** — write |
| Mailbox / file / Teams content | `Mail.Read`, `Files.Read.All`, `Sites.Read.All`, `Chat.Read.All` | **Deferred / rejected** — no implemented diagnostic reads message, file, or chat content; `check_mailbox_status` needs settings only |
| Security containment | `SecurityActions.ReadWrite.All`, `ThreatHunting.Read.All` | **Rejected** — containment is remediation |
| Policy / role / app management | `Policy.ReadWrite.*`, `RoleManagement.ReadWrite.Directory`, `Application.ReadWrite.All` | **Rejected** — privilege-escalation primitives |

## 4. Recommended further narrowing for 011B

1. **Exchange application access policy.** Scope `MailboxSettings.Read` to a
   mail-enabled security group containing only pilot test users. This is the
   single highest-value narrowing available and turns tenant-wide mailbox-settings
   access into pilot-scoped access. Requires Exchange Online PowerShell
   (`New-ApplicationAccessPolicy`) — deliberately **not** performed in 011A, which
   prohibits Exchange workload calls.
2. **Verify and drop `GroupMember.Read.All`** per §2.
3. **Consider Entra scoped role assignment / administrative units** if tenant-wide
   `User.Read.All` proves broader than the pilot needs.

## 5. Summary

| Permission | Type | Consent | Pilot | Write? |
|---|---|---|---|---|
| `User.Read.All` | Application | Granted | Required | No |
| `UserAuthenticationMethod.Read.All` | Application | Granted | Required | No |
| `MailboxSettings.Read` | Application | Granted | Required | No |
| `GroupMember.Read.All` | Application | Granted | Redundancy to verify in 011B | No |

Write-capable permissions granted: **0** (verified programmatically).
