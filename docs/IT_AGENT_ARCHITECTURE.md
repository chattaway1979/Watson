# Watson — H&R AI IT Agent : Architecture & Safety Model

Working product name: **Watson — H&R AI IT Agent**
Company: **H&R Electric Company** (commercial electrical contractor)
Persona: calm, intelligent, Einstein-inspired internal IT operator (original stylized avatar — not a real likeness).

This document is the source of truth for the design, the safety guardrails, and the
forward path to Azure + real Microsoft/RMM integrations. **This system is not built on
Microsoft Copilot Studio.** It uses a custom control-plane architecture so H&R retains full
control over policy, approvals, auditing, and execution.

---

## 1. High-level shape

```
Employee / Manager / Admin / Owner
        │  (Next.js App Router UI — /it/*)
        ▼
   API routes  (src/app/api/it-agent/*)        ← server-side identity resolved here
        │
        ▼
   ┌─────────────────────────── it-agent control plane (src/lib/it-agent) ───────────────────────────┐
   │  triage → troubleshooting → deterministic-agent (Watson)                                          │
   │  tickets · knowledge · action-registry · policy · approval-engine · audit                         │
   │                              │                                                                    │
   │                         TOOL GATEWAY  ── enforces policy + approval + live gate ──┐               │
   │                              │                                                    ▼               │
   │                  ┌───────────┴───────────┐                            ┌──────────────────────┐    │
   │                  │ mock-microsoft365     │                            │ mock-device-management│    │
   │                  │ (future: MS Graph)    │                            │ (future: Intune/Ninja/│    │
   │                  └───────────────────────┘                            │  Atera)               │    │
   │                                                                       └──────────────────────┘    │
   └───────────────────────────────────────────────────────────────────────────────────────────────────┘
        │
        ▼
   Data store (JSON file today → Azure Postgres / Azure SQL later)
```

Every external action — without exception — flows through the **Tool Gateway**, which applies
policy, routes risky work to the **Approval Engine**, and consults the **live-execution master
gate**. The UI is never the only safety boundary.

## 2. Modules (src/lib/it-agent)

| File | Responsibility |
|------|----------------|
| `types.ts` | All domain types, enums (categories, statuses, priorities, risk levels, audit events) |
| `constants.ts` | Labels, role ranks, **`isLiveExternalExecutionEnabled()`** master gate |
| `action-registry.ts` | Single source of truth for every action: risk, role, approval, exec mode, connector, schemas. `liveExecutable` is hard-coded `false` for all. |
| `policy.ts` | `canPerformAction`, `requiresApproval`, `canApproveAction`, ticket visibility/manage |
| `approval-engine.ts` | Create approval requests, decide (approve/reject), defense-in-depth execution gate |
| `tool-gateway.ts` | The only path to invoke actions; routes safe→mock, risky→approval, live→blocked |
| `triage.ts` | Deterministic keyword classifier (category + priority + confidence) |
| `troubleshooting.ts` | Per-category plans: causes, checks, steps, escalation, recommended actions, KB links |
| `ai-provider.ts` | `AiProvider` abstraction + deterministic fallback (no key needed) |
| `deterministic-agent.ts` | Watson conversational orchestration; labels each action's disposition |
| `tickets.ts` | Ticket lifecycle, messages, internal notes, events, escalation, reopen |
| `knowledge.ts` / `seed-knowledge.ts` | KB service + 14 seeded H&R articles + mock users/devices |
| `audit.ts` | Backend-owned audit logger |
| `mock-microsoft365.ts` | Mock M365/Graph connector (lookups + preparatory packets) |
| `mock-device-management.ts` | Mock RMM connector (Intune/NinjaOne/Atera-style) |
| `session.ts` | **Demo** identity resolver (replace with Entra ID in production) |

## 3. Safety guardrails (enforced in the backend)

1. **Live-execution master gate** — `IT_AGENT_LIVE_EXTERNAL_EXECUTION` defaults to `false`.
   `isLiveExternalExecutionEnabled()` is checked in `policy.ts`, `tool-gateway.ts`, and
   `approval-engine.ts`. Nothing in this build flips it true.
2. **No live external execution** — actions targeting M365/Entra/Exchange/Intune/NinjaOne/Atera
   run in mock mode or are queued for approval. There are zero real API calls.
3. **Risk tiers & approval** —
   - *low* (search KB, create ticket, add note, send instructions): may run automatically.
   - *medium* (user/device/MFA/license lookups, mock sync/diagnostics): admin/manager, mock only.
   - *high* (password/MFA reset prep, license, shared mailbox, software install, remote support):
     **always require approval**.
   - *critical* (disable/delete user, wipe device, privileged role change, mailbox content access,
     offboarding shutdown): **owner/admin approval AND live execution permanently blocked here**.
4. **Watson can never approve** — the agent may recommend/prepare/queue, but `canApproveAction`
   and `decideApproval` reject any agent/`role==='agent'` approver.
5. **No self-approval** — a requester cannot approve their own request.
6. **Critical = mock-blocked too** — critical actions have `mockExecutable=false`; on approval they
   are explicitly *live-blocked* and never executed.
7. **Full audit** — every meaningful event is written by the backend audit logger
   (ticket lifecycle, AI triage, recommendations, approvals, mock executions, connector calls,
   policy decisions, KB changes).
8. **Clear dispositions** — Watson labels each action as *recommended / prepared / approval-required
   / mock-executable / live-disabled* and never claims to have executed external work.

## 4. Data model
JSON store today; production schema in `database/migrations/0001_add_it_agent_foundation.sql`
(additive, Postgres/Azure-SQL compatible): `it_users`, `it_tickets`, `it_ticket_messages`,
`it_ticket_events`, `it_agent_actions`, `it_action_approvals`, `it_audit_logs`,
`it_knowledge_articles`, `it_mock_users`, `it_mock_devices`. The migration is **created only,
not applied** by this build.

## 5. Future Azure hosting plan
- **Compute**: Azure Container Apps (preferred; `output: 'standalone'` already set) or App Service.
- **Database**: Azure Database for PostgreSQL (or Azure SQL). Swap the repository in `src/lib/store`
  for a Postgres client; apply `0001_add_it_agent_foundation.sql` via a controlled migration runner.
- **Secrets**: Azure Key Vault for Graph/RMM credentials and AI keys (never in source/env files).
- **Identity**: Microsoft Entra ID (OIDC) replacing `session.ts`; map Entra app roles/groups to
  Watson roles (employee/manager/admin/owner).
- **Storage**: Azure Storage for diagnostics bundles / attachments.
- **Observability**: ship audit logs to a tamper-evident sink (Log Analytics / immutable storage).

## 6. Future Microsoft Graph integration plan (read-only first)
1. Implement `MsGraphConnector` behind the existing `M365Connector` interface.
2. Start **read-only**: `lookup_user`, `check_license_status`, `check_mfa_status`,
   `check_mailbox_status`, `check_group_membership` against Graph with delegated/least-privilege
   app permissions.
3. Keep all *prepare_* and write actions behind the approval engine + live gate.
4. Only after security review, allow specific high-risk writes with the live gate enabled per-action
   and per-environment — never globally.

## 7. Future Intune / NinjaOne / Atera plan
- Implement `IntuneConnector` / `NinjaOneConnector` / `AteraConnector` behind `DeviceConnector`.
- Read-only device inventory/compliance first; mock sync/diagnostics become real calls.
- Device wipe/retire remains **critical** and live-gated indefinitely until an explicit, audited
  authorization process exists.

## 8. AI provider plan
`AiProvider` interface (`classifyIssue`, `generateTroubleshootingPlan`, `summarizeTicket`,
`recommendActions`, `triage`). Today: deterministic fallback (explainable, no network). Later:
add an Anthropic or Azure OpenAI provider keyed from Key Vault; the deterministic provider remains
the safe default and the offline fallback.

## 9. Admin approval workflow
1. Watson or an admin invokes a high/critical action via the Tool Gateway.
2. The gateway creates an **ApprovalRequest** capturing the full proposed payload; the linked ticket
   moves to `approval_required`.
3. An eligible human (admin for high, owner for critical) approves or rejects in `/it/admin/approvals`.
4. On approve: safe mock actions are **simulated**; critical/live actions are **blocked**.
5. Every step is audited (`approval_requested`, `approval_approved`/`rejected`, `mock_action_executed`).

## 10. Known limitations
- Demo role switcher instead of real auth (documented; replace with Entra ID).
- JSON file store, not a real database (schema provided; not applied).
- Connectors are mock; no real Microsoft/RMM/Azure calls.
- Deterministic AI only (no LLM wired in this build).
- Next.js `output: standalone` set for Azure; production deploy not performed.
- Platform: **Next.js 16.2.9 + React 19.2.7**, ESLint 9 flat config, Node LTS 24 pinned (`.nvmrc`;
  `engines.node >=22.11.0`). `npm audit` = **0 vulnerabilities** — the prior Next.js security gate is
  CLEARED. Remaining limitations are product-level (mock-only), not security: demo auth, JSON store,
  deterministic AI, mock connectors. Not a deployable production IT system until real auth + database
  + reviewed integrations are added. See `docs/BUILD_VERIFICATION.md`.

## 11. Next recommended build
0. [DONE] Migrated to **Next.js 16.2.9** + React 19; dynamic `params` are async; lint on ESLint 9 flat
   config; `npm audit` = 0 vulnerabilities. Security gate cleared (see `docs/BUILD_VERIFICATION.md`).
1. Microsoft Graph **read-only** integration (behind the existing interface + Key Vault).
2. Choose and implement one device connector (Intune / NinjaOne / Atera) — read-only first.
3. Azure hosting + Postgres migration runner + CI build/test gates.
4. Real auth/role hardening via Entra ID; map app roles to Watson roles.
5. Ticket notifications (email/Teams) and employee self-service onboarding/offboarding forms.
6. Production deployment checklist + per-action live-execution authorization process.
