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
