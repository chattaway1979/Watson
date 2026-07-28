# Watson — Graph Pilot Test-User Plan (011A, Phase 6)

Task: **WATSON-GRAPH-PREREQUISITES-PROVISION-011A**.

Plan only. **No account was created, licensed, invited, modified, or deactivated
by this task**, and no Graph query was run against any user.

Contains no user object identifiers.

---

## 1. Assessment status

Directory user enumeration was **not performed**: the automation environment
refused the directory-listing call, and 011A independently prohibits reading
employee data. The population assessment (how many licensed non-admin members
exist, which have managed devices) is therefore **an open gap carried into
011B** — it must be completed by the owner in the portal, or with an explicit
allowance, before test users are selected.

## 2. Is `info@hrelectriccompany.com` suitable?

It may **remain** as a browser-authentication account, but it is **not suitable
as Graph evidence-test subject**. Three independent reasons:

1. **It defeats actor/target separation.** Watson's central authorization
   invariant is that the signed-in *actor* is distinguishable from the
   diagnostic *target*. A shared account collapses that distinction, so a pass
   against it would not prove isolation holds — the very property 011B must
   demonstrate.
2. **Shared credentials break attribution.** The audit trail records the acting
   actor. If several people can sign in as `info@`, `diagnostic_read_performed`
   entries cannot be attributed to a person, weakening the audit control.
3. **Unrepresentative state.** A shared/reception mailbox typically has atypical
   licensing, MFA registration, and group membership, so healthy-vs-broken
   evidence drawn from it does not generalize to a real employee.

**Recommendation:** keep `info@` only as a sign-in smoke-test identity; select a
separate ordinary employee as the diagnostic *target*.

## 3. Required test-user set for 011B

| # | Role | Required | Purpose |
|---|---|---|---|
| T1 | Ordinary licensed employee, no admin role | **Yes** | Baseline for all five reads; healthy-state evidence |
| T2 | Employee with a managed Windows device | Optional | Only if a device diagnostic is added — none exists today |
| T3 | Employee with a managed iPad | Optional | As above |
| T4 | Second ordinary employee | **Yes** | Required to prove cross-user isolation: T1 must not be able to target T4 |

Constraints for every test user:

- **No** administrator directory role.
- **No** elevated Watson role (`Watson.Admin` must not be assigned).
- Licensed such that `check_license_status` returns a real SKU.
- MFA registered, so `check_mfa_status` returns a non-empty method list.
- Member of at least one group, so `check_group_membership` is meaningful.
- A mailbox exists, so `check_mailbox_status` resolves.

T4 is not optional: without a second ordinary employee, 011B can demonstrate
that reads *work* but cannot demonstrate that they are *contained*.

## 4. Actor-vs-target distinction

011B must exercise, and record evidence for, all four combinations:

| Actor | Target | Expected |
|---|---|---|
| Admin | T1 | `evidence` (live_readonly) |
| T1 (employee) | T1 (self) | per Watson policy — self-diagnosis only if policy allows |
| T1 (employee) | T4 (another employee) | **`denied`** — must not return evidence |
| Unauthenticated | any | **401 / redirect**, never evidence |

The third row is the load-bearing test. A Graph permission or Azure role must
never substitute for Watson's own actor authorization: the app-only credential
can read *every* user in the tenant, so containment is enforced entirely by
Watson's policy layer, not by Graph.

## 5. Privacy and data minimization

- The connector already applies `$select` on every call that supports it; keep it.
- `check_mailbox_status` must stay limited to **settings**; never message content.
- Audit entries must record **state only** — no payloads, no secrets.
- Prefer scoping `MailboxSettings.Read` with an Exchange application access
  policy limited to the test users (see `GRAPH_PERMISSION_MATRIX_011A.md` §4).
- Retain evidence from the controlled test only as long as needed to validate,
  then discard.

## 6. Cost and impact controls

No paid account was created and no license was assigned. If test users require
new licenses, that is a **cost decision for the owner** and is explicitly out of
scope for 011A. Preferred order:

1. Reuse existing licensed employees who consent to being diagnostic targets.
2. Use trial licenses if available at no cost.
3. Only then purchase — owner decision.

## 7. Cleanup / deactivation

After 011B validation:

- Remove any group created solely to scope the Exchange application access policy.
- If test accounts were created, disable then delete them after evidence review.
- Re-verify `IT_AGENT_GRAPH_LIVE_READONLY=false` after the controlled test.
- Retain the audit trail; discard collected evidence payloads.

## 8. Open gaps carried to 011B

1. Directory population not assessed (blocked — see §1).
2. Test users T1 and T4 not identified.
3. No confirmation that candidate users have MFA registered and licenses assigned.
4. Exchange application access policy not created (requires Exchange Online
   PowerShell; prohibited in 011A).

---

# 011B update — Phase 7

## 9. What 011B established

Aggregate tenant facts (no employee identity read or exposed):

| Fact | Value |
|---|---|
| Licensed **and** enabled member accounts | **13** |
| Microsoft 365 Business Premium (`SPB`) seats | 5 enabled / 5 consumed — **0 free** |
| `O365_BUSINESS_PREMIUM` seats | 5 / 5 — **0 free** |
| `EXCHANGESTANDARD` seats | 3 / 3 — **0 free** |

> **Consequence: T1 must be an existing licensed employee.** Every paid seat is
> consumed, so provisioning a fresh test account would require **purchasing a
> licence** — a cost decision that is not authorized. Do not create an unlicensed
> account either: `check_license_status` and `check_mailbox_status` would return
> empty, making the pilot unrepresentative.

Per-user enumeration was **refused by the automation environment**, so candidate
selection is an owner step. It was not worked around.

## 10. Exact owner selection steps (portal, ~3 minutes)

1. **Entra admin centre → Users → All users**. Add the **Licenses** column.
2. Filter to licensed, enabled accounts. Exclude `info@hrelectriccompany.com`
   (shared — see §2).
3. For each candidate, open **Assigned roles** and confirm it is **empty**. Any
   directory role — Global Administrator especially — disqualifies the account.
4. Confirm the account is **not** assigned the `Watson.Admin` app role:
   **Enterprise applications → Watson Non-Production → Users and groups**.
5. Open **Authentication methods** and confirm at least one method is registered,
   so `check_mfa_status` returns a non-empty result.
6. Confirm **Groups** shows at least one membership, so `check_group_membership`
   is meaningful.
7. Pick **two** such accounts:
   - **T1** — the pilot subject.
   - **T4** — a second ordinary employee, used *only* as a refusal target to
     prove cross-user isolation. T4 is never diagnosed.
8. Record both **only** in the deployment record, by alias (`T1`, `T4`).

**Do not**, at any step: create an account, assign or purchase a licence, reset a
password, change MFA, or alter any directory role.

## 11. Why T4 is not optional

The Graph credential is app-only and can read every user in the tenant. The only
thing preventing an employee from pulling a colleague's evidence is Watson's own
policy layer. Without a second real account, 011C can demonstrate that reads
*work* but not that they are *contained* — and containment is the property that
actually matters. The refusal path is covered by deterministic tests in
`scripts/graph-managed-identity.selftest.ts` section `[54]`; T4 confirms it end
to end against a real directory.

## 12. Optional device user

A managed-Windows or managed-iPad user is **not needed for 011C**. Watson has no
Intune diagnostic implemented, and no device-management permission is granted or
requested. Defer until a device diagnostic exists.

## 13. Remaining gaps after 011B

1. T1 and T4 still unidentified (owner step, §10).
2. MFA registration and group membership unconfirmed for any candidate.
3. Exchange scoping decision outstanding — see `docs/EXCHANGE_MAILBOX_SCOPING_011B.md` §7.
