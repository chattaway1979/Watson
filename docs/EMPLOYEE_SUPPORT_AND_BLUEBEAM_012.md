# Watson — Employee Support Experience & Bluebeam Skill Pack (012)

Parts A–E of **WATSON-EMPLOYEE-SUPPORT-AND-BLUEBEAM-SKILL-PACK-012**.

Built on the isolated branch `feature/watson-employee-bluebeam-support-012` from
baseline `928a4866…`. No Graph permission was broadened, no live employee read
occurred, no real system was changed.

---

## 1. The eleven employee-facing states

`src/lib/it-agent/support/employee-states.ts`

Ready · Listening · Investigation · Diagnosis · Approval · Working ·
Verification · Resolution · Escalation · Open Issue · Employee Report

These are deliberately **separate** from the engine's internal `CaseState`. The
internal machine exists to make transitions safe; the employee states exist to
make the experience legible. `toEmployeeState()` maps between them, so the
internal machine can change without silently changing what an employee is told.

### Resolution integrity

The most common way support tooling lies is calling a case resolved because
advice was given. `decideResolution()` requires **all four**:

1. the action completed,
2. the symptom is gone,
3. **the employee's actual workflow is restored**, and
4. the employee confirmed it — Watson never assumes.

If the error clears but the person still cannot work, the case becomes
`open_issue`, not `resolution`. `instructionsOnlyResolve()` returns `false`
permanently: handing over instructions is not a resolution.

## 2. Cause taxonomy

`src/lib/it-agent/support/causes.ts` — eleven classes, each with an
employee-facing summary, an owner, and a routing queue:

user training · application defect · Windows/endpoint · M365 identity/access ·
network · file-specific · permissions · service outage · licensing ·
printer/driver · **unknown cause**

`unknown_cause` is a first-class outcome. Seven classes are marked
non-repairable by Watson — including `unknown_cause`, so an unevidenced guess
cannot lead to a repair attempt.

`narrowCause()` encodes the highest-value discriminator in desktop support —
"does it happen with everything, or only this one thing?" — and returns
`sufficient: false` whenever a conclusion would be a guess.

## 3. Bluebeam skill pack

`src/lib/it-agent/skills/bluebeam/`

Ten issue families, each specifying minimum evidence, diagnostic branches with
confidence deltas, candidate causes, employee-safe actions, approval-required
actions, **prohibited actions**, a three-level verification sequence, escalation
conditions, handoff fields, a repair-time range, and a default priority.

| Family | Default priority |
|---|---|
| Launch and stability | high |
| Sign-in and licensing | high |
| Studio Sessions and Projects | high |
| PDF opening and rendering | high |
| Printing and plotting | high |
| Measurements, scale, calibration | **urgent** |
| Markups and Tool Chest | high |
| OCR, search, overlays, slip-sheeting | normal |
| SharePoint, OneDrive, file locking | **urgent** |
| Profiles and settings recovery | normal |

Measurement and file-locking are urgent because both silently destroy work:
a wrong scale produces a confidently wrong takeoff that gets priced, and a
mishandled conflicting copy loses markups permanently.

### Domain safety rules (each is a test, not a comment)

- **Never trust the printed scale label.** Plan sets are routinely rescaled when
  issued; trusting the label is precisely how takeoffs go wrong.
- **Never reset or reinstall before the Tool Chest, stamps and columns are
  backed up.** This is unrecoverable user work, often years of it.
- **Never delete a conflicting copy.** It frequently holds the only record of
  someone's markups.
- **Never flatten, OCR, or overwrite the original plan set** — it is evidence and
  often a contract document. Work on a copy.
- **Never state licence status without verified entitlement data.** Watson has no
  licence source and must say so rather than guess.
- **Never present a capability limitation as a defect.** A scanned sheet has no
  text layer; search failing is expected, and OCR is the answer, not a repair.

### One question at a time

`nextBestQuestion()` returns exactly one question, skips anything already
answered, and reports how many remain. `hasMinimumEvidence()` gates any proposal.
When two families tie, `disambiguationQuestion()` asks which one it is rather
than silently walking the wrong tree.

## 4. Action tiers (Part D)

Tier 0 informational · Tier 1 employee-safe · Tier 2 approval required ·
Tier 3 technician/administrator only.

Every destructive or hard-to-reverse action must confirm a backup path, disclose
impact, obtain explicit approval, carry rollback instructions, and **stop if
rollback cannot be assured**. The endpoint runtime enforces this: an action whose
rollback is missing is refused rather than executed.

## 5. Technician handoff (Part E)

`src/lib/it-agent/support/handoff.ts`

A handoff that omits what was already ruled out is worse than none — it wastes
the technician's time and makes the employee repeat themselves. The record
therefore treats **negative findings as first-class**: what was tried, what did
not work, and what remains unknown.

`assessHandoffCompleteness()` refuses to consider a handoff shippable without
`actionsAttempted`, `ruledOut`, and `stillUnknown`. "We ruled nothing out" is a
legitimate value; silence about it is not.

`redactForHandoff()` strips email addresses, GUIDs, JWT-shaped tokens, and UNC
paths before anything reaches a ticket, so a stray address pasted into a symptom
description cannot leak.

## 6. Tests

| Section | Coverage |
|---|---|
| `[55]`–`[59]` | Endpoint catalogue integrity, consent and stop, refusals, Bluebeam inspection/repair flow, verification and escalation |
| `[60]` | Eleven employee states, mapping, resolution integrity |
| `[61]` | Cause taxonomy, repair permission, evidence narrowing |
| `[62]` | Ten families complete; every domain safety rule asserted |
| `[63]` | Intent detection, ten classification cases, one-question-at-a-time |
| `[64]` | Evidence gate before any repair |

Suite total **464 → 616** (+152). No existing test weakened or removed.

## 7. What is NOT built

- No employee-facing UI for the new states — the engine and skill pack are
  wired, the `/watson` surface still uses the existing scenario set.
- The Bluebeam families are not yet joined to the live case engine's scenario
  registry; that is a focused follow-up.
- No endpoint agent exists (see `ENDPOINT_AGENT_ARCHITECTURE_012.md`).
- No live Graph or device call of any kind.
