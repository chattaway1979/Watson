# Watson Remote IT Operator — V1 Foundation (Teams vertical slice)

Turns Watson from a complaint-classifying chatbot into an evidence-first operator that runs:

**identify → connect → inspect → diagnose → authorize → remediate → verify → report**

Watson inspects the endpoint first and asks a question only when evidence cannot answer it.

## Root cause of the old "useless" behaviour
The prior pilot flow (`src/lib/it-agent/triage.ts` + `troubleshooting.ts` + `deterministic-agent.ts`) classified the complaint and returned **static troubleshooting text** — it never inspected the device. This module replaces that pattern for the Teams slice with real (simulated) endpoint evidence driving the diagnosis. The old static path is untouched and remains only as a fallback for unsupported categories.

## Module (`src/lib/endpoint/`)
| File | Responsibility |
|------|----------------|
| `contracts.ts` | Typed contracts (doc 02) + case/event/hypothesis/escalation types. No command text anywhere. |
| `catalog.ts` | Typed, allowlisted action catalog (6 read-only + 3 low-risk + 1 elevated-but-blocked). |
| `policy.ts` | Deterministic gate: deny-by-default, tenant/device/identity binding, typed param validation, risk floor, approval floor, no self-approval, command-injection block. |
| `simulator.ts` | Labelled SIMULATOR adapter implementing `EndpointOperationsPort` (8 scenarios). |
| `executor.ts` | The only path to the endpoint: policy → timeout → execute → **mandatory verification** → audit. Fails closed on non-low-risk. |
| `events.ts` | Append-only, immutable event stream (source of truth) with secret redaction. |
| `playbook-teams.ts` | Teams evidence plan + evidence-grounded hypothesis ranking. |
| `orchestrator.ts` | Case state machine + the full loop; employee consent for device changes. |
| `render.ts` | Employee-safe text (no internal engine labels; honest simulation disclosure). |
| `escalation.ts` | Technician-ready escalation package. |

## Actual vs simulated
- **Real, deterministic:** policy, executor, verification, state machine, event/audit trail, catalog, playbook, escalation, employee rendering. Provider-neutral `EndpointOperationsPort`.
- **Simulated:** all endpoint evidence and effects come from `simulator.ts`, clearly labelled (`provenance.simulated = true`, `source: 'simulator'`), and disclosed to the employee. **No real machine is inspected or changed.** Real Intune/RMM control is unproven until an adapter is connected and a consented managed test device is used.

## Security controls (enforced in code, not the UI)
Typed allowlist only · no arbitrary shell/PowerShell (LLM cannot execute; command-like input rejected) · deny-by-default · tenant + device + assignment binding · risk floor · approval floor (employee consent for low-risk; elevated needs IT approver; no self-approval; employees can't approve privileged) · elevated/critical fail closed in this pilot · mandatory verification before "resolved" · immutable audit with secret redaction · emergency stop · simulation disclosure.

## Actions
Read-only: `collect_device_health`, `collect_process_health`, `collect_event_logs`, `collect_network_health`, `inspect_teams_health`, `collect_support_bundle`.
Low-risk (employee consent): `restart_teams`, `clear_teams_cache`, `trigger_intune_sync`.
Elevated (defined, **not** pilot-executable): `reset_user_password`.

## Tests / demos
`npm run endpoint:selftest` → 69 deterministic checks (evidence-before-questions, different-evidence-different-diagnosis, denials, approval floor, timeout/verify-fail-unresolved, audit completeness, no-label leakage, tenant isolation) + 3 simulator demos (A restart, B cache clear, C network escalation). No network, no real device.

## Remaining for a real managed-device pilot
1. Implement an Intune/Graph (and/or RMM) adapter behind `EndpointOperationsPort` with device-bound identity, authenticated encrypted transport, and separate read/write credentials from Key Vault.
2. Map read-only evidence + the 3 low-risk actions to real vendor commands; keep the same policy/verification.
3. One consented non-production managed Windows device; verify real evidence, real action, real verification.
4. Then (separate owner GO): merge + staged deploy. **This build does not merge, deploy, or touch production or any real device.**

## Verdict
Watson can now **inspect → diagnose → remediate → verify → escalate** through a real, provider-neutral endpoint seam — proven end-to-end against a labelled simulator. It is no longer only a chatbot in architecture; it is not yet proven against a real managed device (adapter + consented pilot required).
