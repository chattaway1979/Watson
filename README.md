# Watson — H&R AI IT Agent

A controlled, auditable internal **AI IT helpdesk** foundation for **H&R Electric Company**.
Watson is the first member of a planned internal AI agent workforce: an Einstein-inspired,
calm internal IT operator that triages issues, suggests fixes, opens tickets, prepares
controlled IT actions, and **escalates anything risky to a human for approval**.

> **Safety first.** This build runs entirely in **MOCK MODE**. No real Microsoft 365, Entra ID,
> Intune, NinjaOne, Atera, or Azure calls are made. Every risky/critical action is **queued for
> human approval and simulated only**. Live external execution is disabled by default and is
> enforced by the backend, not the UI. This is **not** built on Microsoft Copilot Studio — it
> uses a custom control-plane architecture.

> **Build status (2026-06-26 — Next.js 16):** ✅ Builds, type-checks, lints (ESLint 9 flat config),
> and passes 63/63 selftests on Windows 11 / Node v26.1.0. **Security gate CLEARED** — migrated to
> Next.js 16.2.9 + React 19; `npm audit` = **0 vulnerabilities** (was 4 high + 1 moderate on 14.2).
> ⚠️ Still a MOCK-ONLY MVP (demo auth, JSON store, mock connectors): the dependency-security blocker
> is resolved, but do not deploy as a real IT system until real auth + database + reviewed
> integrations are added. Details in [`docs/BUILD_VERIFICATION.md`](docs/BUILD_VERIFICATION.md).

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000  (redirects to /it/help)
```

Other commands:

```bash
npm run typecheck            # tsc --noEmit  (passes)
npm run it-agent:selftest    # 63 safety/domain self-tests (all pass)
npm run lint                 # eslint . (flat config)
npm run build                # production build
npm start                    # run the production build
```

### Try it (demo roles)
There is **no real auth** in this MVP. Use the **role switcher** in the top-right header to
act as Employee / Manager / Admin / Owner. Backend policy is enforced from the resolved
server-side identity, not the UI selection.

- `/it/help` — employee chat/intake with Watson + issue category cards
- `/it/tickets` — your tickets
- `/it/admin` — admin dashboard (Admin/Owner role)
- `/it/admin/approvals` — approve/reject prepared actions
- `/it/admin/audit` — audit log
- `/it/admin/actions` — action registry + Tool Gateway runner

## What's mock vs real
| Area | Status |
|------|--------|
| Triage / troubleshooting / ticketing / approvals / audit | **Real, working logic** |
| AI provider | **Deterministic rule-based** (LLM pluggable later; no key needed) |
| Microsoft 365 connector | **Mock** (deterministic data; no Graph/Exchange/Entra) |
| Device / RMM connector | **Mock** (no Intune/NinjaOne/Atera) |
| Data store | **JSON file store** (`/data`) — Postgres-ready schema in `database/migrations` |
| Auth | **Demo role switcher** — replace with Entra ID / NextAuth for production |
| Live IT execution | **Disabled** (`IT_AGENT_LIVE_EXTERNAL_EXECUTION=false`) |

## Environment
See `.env.example`. All defaults are safe; the app never hard-fails on missing AI/DB credentials.

Key flag: `IT_AGENT_LIVE_EXTERNAL_EXECUTION` — **must stay `false`** in this build. The backend
`isLiveExternalExecutionEnabled()` gate independently blocks any live external execution path.

## Architecture
See **[docs/IT_AGENT_ARCHITECTURE.md](docs/IT_AGENT_ARCHITECTURE.md)** for the full design,
safety model, Azure hosting plan, and future Microsoft Graph / Intune / NinjaOne / Atera plans.

