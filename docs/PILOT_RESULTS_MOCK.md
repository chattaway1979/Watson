# Watson — Local Mock Employee Pilot Results

Executed locally in **authenticated demo mode** (deterministic engine + routes;
no browser, no network, no Azure/Microsoft/voice calls). Live Graph reads and
external execution were **off**. Employee identity: a demo employee actor. This
is the evidence set the owner-run Entra pilot should reproduce in a browser once
the Azure/Entra prerequisites (§ "Blocking prerequisites") are in place.

No tokens, secrets, full claims, or raw Graph payloads appear below.

## Scenario-by-scenario evidence

| # | Scenario | Platform | Case | Follow-up | Diagnostics (plain-language) | Diagnosis | Confidence | Est. time | Approval action | Simulation | Verify | Final state | Escalation | Result |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Outlook re-signin | windows | WC-1001 | (none) | account, licence, mailbox, sign-in activity | Expired Outlook sign-in session | high | ~3–5 min | Refresh Outlook sign-in | completed | works | resolved | — | **PASS** |
| 2 | OneDrive not syncing | windows | WC-1002 | (none) | account, OneDrive sync | Sync engine stuck | high | ~3–8 min | Restart OneDrive sync | completed | works | resolved | — | **PASS** |
| 3 | SharePoint access | unknown | WC-1003 | (none) | account, group access | Not in the access group | high | technician review | — (no safe employee repair) | n/a | n/a | escalated | Microsoft 365 | **PASS** |
| 4 | Teams A/V on iPad | ipados | WC-1004 | (none) | this device, Teams app | Missing permission / broken install | high | ~15–35 min | Reinstall managed app | completed | works | resolved | — | **PASS** |
| 5 | Slow / low storage | windows | WC-1005 | (none) | this device, storage & performance | Needs a restart | high | ~5–12 min | Restart device | completed | works | resolved | — | **PASS** |
| 6 | Lost device | windows | WC-1006 | (none) | (none — recorded & routed) | Lost/stolen device | (n/a) | technician review (urgent) | — (no repair) | n/a | n/a | escalated | **Security** | **PASS** |
| 7 | Unknown issue | unknown | WC-1007 | (none) | (none) | Unclassified | (n/a) | technician review | — (no repair) | n/a | n/a | escalated | General IT | **PASS** |

Additional flows verified via the automated suite (342 tests): one-question-at-a-time
follow-up (Outlook without platform), device-correction handling, technician
request → immediate escalation, approval boundaries (ambiguous ≠ approval;
decline → no change; run blocked before approval), safe-stop, "still broken" →
same case (no new case), partial → stays open, employee-safe vs admin reports,
own-case isolation, and admin-only queue.

## Security / lost-device flow (Part D)

- Lost device escalates **immediately to Security** (routing = Security, security
  flag set), **not** a normal support request.
- **No** automatic wipe, lock, disablement, or containment occurs (no remediation
  exists in this build).
- Available evidence and the transcript are preserved on the case.
- Employee sees an urgent, calm message ("flagged to the security team …").
- Admin report carries the Security classification + routing; expected human
  **response time** is separate from any repair estimate.

## Defects found & corrected in this session

1. Auto-escalated cases (lost / unknown) reported no likely cause → engine now
   records the scenario's primary hypothesis before escalating (reports read
   meaningfully). Covered by new tests.
2. Employee shell lacked a clear pilot/simulation label and had mouse-only
   push-to-talk + unlabeled input → added a calm pilot note, keyboard-accessible
   mic with aria-label, input aria-label, and focus-visible states.
3. Approve→run could chain past a non-granted state → guarded so run fires only
   when approval is actually granted (one approval, one action).

## Blocking prerequisites (owner / Azure admin) before the browser Entra pilot

1. Non-production Azure App Service (Linux/Node) + deploy access — **owner**.
2. Non-production Entra tenant + Watson login app registration — **Azure admin**.
3. App Service Authentication (Easy Auth) configured for that app — **owner/Azure admin**.
4. Admin **group object id** or **app role** assigned to admin testers — **Azure admin**.
5. At least one **admin** test account and one **employee** test account — **owner**.
6. Explicit authorization to deploy to the non-production host — **owner**.

Until these exist, no Azure/Microsoft change is made; the code is deploy-ready
(`output: standalone`, `/api/health`, `npm run verify:config`).
