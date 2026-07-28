# Watson — Endpoint Agent Architecture (012, Part F)

**Watson cannot currently control any employee computer.** No agent exists, no
device is enrolled, no command has ever been executed. This document specifies
what such an agent would have to be, and the permission model in this slice is
already implemented and enforced by tests so the rules are proven before
anything is installed.

Nothing in 012 touched a real device, enrolled anything, or executed a command.

---

## 1. Why an agent at all

Written instructions have a ceiling. "Open Task Manager, find Bluebeam, check
whether it says Not Responding" fails when the person is on a plan set deadline,
does not know what a hung process looks like, or reads the wrong column. The
useful version of Watson inspects the machine, states what it found, and offers
a specific reversible action.

That capability is also the most dangerous thing Watson could acquire, which is
why the permission model exists before the agent does.

## 2. Components

| Component | Runs where | Purpose |
|---|---|---|
| **Orchestrator** | Azure (existing Watson App Service) | Diagnosis, action selection, policy evaluation, approvals, audit |
| **Action catalogue** | Azure, versioned in source | The allowlist. Nothing outside it is executable |
| **Agent service** | Windows service on the device, signed, Intune-deployed | Device inspection, process and file operations, health reporting |
| **Session companion** | The employee's own session | UI Automation, application navigation, the visible indicator and Stop control |
| **Approval service** | Azure | Employee and administrator approvals, short-lived authorisation |
| **Audit sink** | Azure, append-only | Tamper-evident record of every request, refusal, and result |

The service/companion split is not cosmetic. UI Automation requires the
interactive desktop and the user's own token; machine-scope work requires the
service. Collapsing them into one elevated process that can also drive the UI
would create exactly the "silently controls the computer" capability that Tier 4
prohibits.

## 3. Trust boundaries

```
   employee  ──consent/stop──▶  session companion  ──┐
                                                     │ signed, short-lived,
   orchestrator ──action id──▶  agent service  ◀──────┘ device-bound authorisation
        │                            │
        │                            └──▶ Windows / applications
        └──▶ audit sink (append-only)
```

Four boundaries, each of which must hold on its own:

1. **Model → catalogue.** The model emits an action *id*. It never emits a
   command. `isModelProposalAcceptable()` rejects anything command-shaped and
   anything unregistered, so a prompt-injected instruction cannot become an
   executed command.
2. **Orchestrator → agent.** The agent accepts only signed action manifests
   bound to a specific device, user, and session, with a short expiry. A replayed
   or retargeted manifest is refused.
3. **Agent → device.** Each action maps to one pre-written implementation with a
   fixed parameter shape. There is no generic "run this" entry point.
4. **Employee → session.** Consent precedes everything, a visible indicator runs
   for the session's whole life, and Stop is immediate and irreversible.

## 4. Threat model

| Threat | Mitigation | Enforced today |
|---|---|---|
| Prompt injection makes the model issue a destructive command | Model selects ids only; command-shaped input rejected on sight | ✅ tested |
| Compromised orchestrator drives mass remediation | Per-device binding, short-lived authorisation, per-action approval, rate limits | ⚠️ designed |
| Agent used as a general remote shell | No shell entry point exists; catalogue is the whole API | ✅ tested |
| Employee unaware their machine is being driven | Mandatory disclosure, persistent indicator, one-click Stop | ✅ tested |
| Destructive action with no way back | Rollback required for every mutating action; refusal without one | ✅ tested |
| Unsaved work destroyed | Hard prerequisite: check must have run **and** report no pending work | ✅ tested |
| Privilege creep via "temporary" elevation | Tier 3 needs administrator approval; autonomous mode caps at Tier 1 | ✅ tested |
| Silent scope expansion | Catalogue is versioned in source and reviewed as code | ✅ structural |
| Secrets or personal data in logs | Redaction before any record leaves Watson | ✅ tested |
| Stale agent doing the wrong thing | Fail-closed when disconnected, outdated, or unable to reach policy | ⚠️ designed |

"⚠️ designed" means specified here and not yet implemented — those are 013 work,
not claims about today.

## 5. Permission tiers

| Tier | Meaning | Approval |
|---|---|---|
| 0 | Observation only — nothing changes | none |
| 1 | Low-risk reversible — launch, retry sync, test a known-good file | none |
| 2 | End a hung process, reset profile, clear approved caches, restore backup | employee |
| 3 | Elevation, reinstall, registry, drivers, services, Intune, M365 permissions | administrator |
| 4 | **Prohibited** — refused, never queued for approval | separate workflow |

Tier 4 names its members explicitly: deleting employee files, disabling security
controls, weakening Defender or Intune policy, bypassing authentication,
collecting credentials, exposing tokens, unrestricted shell, silent control,
production tenant permission changes, executing model-generated commands.

**Autonomous mode caps at Tier 1 — lower than assisted mode's Tier 2.** Removing
the human from the loop reduces reach; it does not expand it. This inverts the
usual trajectory on purpose.

## 6. Navigation strategy preference

`application_api` → `command_line` → `os_management_api` → `ui_automation` →
`browser_automation` → `visual_fallback`

Coordinate clicking is last because it cannot verify what it clicked and breaks
on any theme, resolution, or layout change. `isDowngradedStrategy()` flags any
action using a weaker strategy than was available, so drift toward brittle
automation is visible in review rather than discovered in production.

## 7. Bluebeam endpoint tool catalogue

Sixteen registered actions, each carrying prerequisites, required evidence,
expected effect, timeout, success and failure criteria, rollback, audit event,
and post-action verification.

**Tier 0:** inspect process · inspect version/edition · detect hung · check
unsaved work · read profile and Tool Chest locations · OneDrive sync state ·
file read-only/lock/conflicting-copy state · device health · crash logs.

**Tier 1:** open a known-good PDF · launch Bluebeam · retry OneDrive sync.

**Tier 2:** terminate a hung process · back up profile and Tool Chest · switch to
a clean test profile · restore the original profile · clear approved caches.

**Tier 3:** supported repair install.

Three ordering rules are enforced, not merely documented:

- A profile switch **refuses** until a verified backup exists.
- A cache clear **refuses** unless profile paths are out of scope.
- A terminate **refuses** unless the unsaved-work check has run *and* reports
  nothing pending.

Those three are where a naive implementation destroys months of an estimator's
Tool Chest work.

## 8. Employee consent workflow

Before anything runs, the employee sees: what will be inspected (derived from the
actual planned actions, not a generic notice), whether Watson will only observe
or also change things, expected duration, whether applications may close, whether
unsaved work may be affected, and how to stop.

During the session a persistent indicator is visible. **Stop** is one click,
immediate, irreversible for that session, and beats work already authorised.

## 9. Rollout plan

| Stage | Mode | Max tier | Exit criteria |
|---|---|---|---|
| 1 | Guided | 0 | Watson's observations match what a technician independently finds, across ≥20 real cases |
| 2 | Assisted control | 2 | Zero unapproved changes; every rollback exercised at least once; no unsaved-work incident |
| 3 | Autonomous remediation | 1 | ≥50 assisted sessions with no safety refusal bypassed; audit reviewed |

Stage 1 is the long one and should not be rushed: it is where Watson earns the
right to be believed.

## 10. Known limitations

- **No agent exists.** Everything here is mock-enforced.
- Bluebeam has no supported automation API for profile switching; that action
  currently assumes UI Automation and needs vendor confirmation.
- UI Automation cannot run over a locked workstation or an RDP session without a
  visible desktop.
- Crash-log parsing is version-sensitive and will need maintenance.
- Detecting "hung" via window responsiveness produces false positives during
  long legitimate operations, such as OCR over a large plan set.
- The mock device is deterministic; real endpoints are not.

## 11. Prerequisites for the first real endpoint pilot

1. Owner authorisation for an endpoint pilot — **separate from 012**.
2. Code-signing certificate and a signed agent build.
3. Intune deployment ring limited to one or two volunteer devices.
4. Agent authentication design reviewed (device binding, manifest signing, expiry).
5. Audit sink provisioned with append-only retention.
6. Employee-facing consent UI implemented and reviewed.
7. Legal/HR review of employee monitoring and consent wording.
8. Rollback rehearsed for every Tier 2 action on a test device.
9. Written incident procedure for a misbehaving agent, including kill-switch.
10. Named pilot participants who have agreed in advance.

Until all ten are met, Watson operates in guided mode only: it explains what to
check and the employee performs the actions.
