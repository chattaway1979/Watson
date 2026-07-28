# Watson — Exchange Mailbox Scoping for `MailboxSettings.Read` (011B, Phase 6)

Task: **WATSON-MANAGED-IDENTITY-GRAPH-READINESS-011B**.

**Status: PREPARED, NOT EXECUTED.** Every command below requires an interactive
Exchange administrator session. Nothing here was run. No mailbox was read, no
mail was sent, and no mailbox setting was modified.

Contains no tenant, client, or object identifiers — placeholders are marked
`<...>`.

---

## 1. Which mechanism is current

**Exchange Online Application RBAC — not legacy Application Access Policies.**

Microsoft's [RBAC for Applications in Exchange Online](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac)
states plainly: *"This feature extends the current RBAC model in Exchange Online
and it **replaces Application Access Policies**."* The same page provides
explicit migration steps from Application Access Policies to Application RBAC.

`MailboxSettings.Read` is directly supported as the application role
**`Application MailboxSettings.Read`** (protocol: MS Graph).

**Recommendation for Watson: Exchange Online Application RBAC**, scoped by a
management scope over a mail-enabled security group of pilot users.

## 2. The exposure being fixed, and the trap

`MailboxSettings.Read` consented in Microsoft Entra ID is **tenant-wide**: it
authorizes reading mailbox settings for *every* mailbox in the organization.
That grant is currently in place on the Watson managed identity.

> **The critical trap.** Entra and Exchange grants are a **union**, not an
> intersection. Microsoft's FAQ: *"if your Service Principal has `Mail.Read`
> granted in Microsoft Entra ID and you configure a resource-scoped `Mail.Read`
> permission in Application RBAC, it's important that you remove the assignment
> of `Mail.Read` from Microsoft Entra ID. Otherwise, the union ... results in
> **no effective resource scoping**."*
>
> **Adding an Exchange scope without removing the Entra grant achieves nothing.**
> Step 5 below is not optional — it is the step that actually creates the scope.

## 3. Prepared command sequence (owner runs; do not run unattended)

Prerequisites: membership of **Organization Management** (Exchange) or the
**Exchange Administrator** Entra role, and `Connect-ExchangeOnline`.

```powershell
Connect-ExchangeOnline

# 1. Pilot scope group. Mail-enabled security group; ONLY direct members are
#    in scope — nested membership is NOT honoured by Application RBAC.
New-DistributionGroup -Name "Watson-Pilot-Mailboxes" `
  -Type Security -PrimarySmtpAddress "watson-pilot-mailboxes@<your-domain>"

Add-DistributionGroupMember -Identity "Watson-Pilot-Mailboxes" -Member "<T1-upn>"

# 2. Exchange pointer to the MANAGED IDENTITY's enterprise application.
#    Use the Enterprise applications blade values, NOT App registrations.
New-ServicePrincipal -AppId <MI-application-id> -ObjectId <MI-object-id> `
  -DisplayName "Watson Managed Identity"

# 3. Management scope restricted to direct members of the pilot group.
#    MemberOfGroup requires the group's DISTINGUISHED NAME:
#      (Get-Group "Watson-Pilot-Mailboxes").DistinguishedName
New-ManagementScope -Name "Watson Pilot Mailboxes" `
  -RecipientRestrictionFilter "MemberOfGroup -eq '<group-DN>'"

# 4. Scoped role assignment.
New-ManagementRoleAssignment -App <MI-object-id> `
  -Role "Application MailboxSettings.Read" `
  -CustomResourceScope "Watson Pilot Mailboxes"

# 5. REQUIRED — remove the tenant-wide Entra grant, or step 4 scopes nothing.
#    (Remove the MailboxSettings.Read appRoleAssignment from the managed
#    identity's service principal in Entra.)

# 6. Validate WITHOUT reading mailbox content. InScope must be True for the
#    pilot user and False for a non-pilot mailbox.
Test-ServicePrincipalAuthorization -Identity <MI-object-id> -Resource "<T1-upn>" | Format-Table
Test-ServicePrincipalAuthorization -Identity <MI-object-id> -Resource "<non-pilot-upn>" | Format-Table
```

`Test-ServicePrincipalAuthorization` is the validation method: it simulates the
authorization decision and reports `InScope` true/false **without reading any
mailbox data**. It also bypasses the permission cache.

## 4. Order of operations matters

Between step 5 (removing the Entra grant) and the Exchange assignment taking
effect, `check_mailbox_status` will fail closed. Watson treats that as
`graph_permission_incomplete` and never fabricates evidence, so the transient
state is safe — but **do steps 1–4 before step 5**, and expect a cache delay.

## 5. Cache behavior

Microsoft documents a permission cache of **30 minutes to 2 hours** depending on
recent app activity. `Test-ServicePrincipalAuthorization` bypasses it; live Graph
calls do not. Do not conclude scoping has failed until the cache has turned over.

## 6. Known limitations

- **Nested group members are out of scope** — only direct membership counts.
- Exclusive management scopes do not restrict app access.
- Autodiscover is unavailable to RBAC application roles (irrelevant to Watson).
- Supported group types: Microsoft 365 Groups, Mail-Enabled Security Groups,
  Distribution Lists.

## 7. Decision required before 011C

| Option | Exposure | Effort |
|---|---|---|
| **A. Scope via Application RBAC** (recommended) | Mailbox settings readable for pilot members only | Steps 1–6, Exchange admin session |
| **B. Keep the tenant-wide Entra grant** | Mailbox settings readable for **every** mailbox in the organization | None |
| **C. Drop `MailboxSettings.Read` for the pilot** | None; `check_mailbox_status` unavailable | Remove one app role assignment |

Option B is the current state. It is a real, documented exposure and should be a
deliberate choice, not a default. If the first pilot does not depend on mailbox
evidence, **Option C is the cheapest safe answer** and can be reversed later.
