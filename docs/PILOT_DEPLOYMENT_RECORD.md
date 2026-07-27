# Watson — Non-Production Pilot Deployment Record

Non-secret record of the authenticated mock-pilot deployment. Contains **no**
secrets, tokens, client/tenant IDs, or claims. All identity secrets live only in
Azure platform configuration.

## Environment

| Item | Value |
|---|---|
| Purpose | Non-production authenticated mock employee pilot |
| Resource group | `watson-nonprod-rg` (dedicated; not `hr-electric`, not LumenSync) |
| Region | South Central US (near Houston) |
| App Service plan | `watson-nonprod-plan` — **Linux B1** (lowest practical tier that supports Always-On + Easy Auth) |
| Web app | `watson-pilot-hrnp01` |
| Public hostname | `https://watson-pilot-hrnp01.azurewebsites.net` |
| Node runtime | `NODE|22-lts` (satisfies `engines.node >= 22.11.0`) |
| Startup command | `node server.js` (Next standalone; contents at wwwroot root) |
| Deployment method | Run-From-Package (`WEBSITE_RUN_FROM_PACKAGE=1`), zip deploy |
| Health check path | `/api/health` (Easy Auth–excluded; value-free) |
| Deployed commit | `639a7709ecb5a8d824a46e472861ddc36ad4ce31` (recorded in `WATSON_DEPLOYED_SHA`) |

## Identity / Easy Auth

| Item | Value |
|---|---|
| Entra app (registration + enterprise app) | display name **Watson Non-Production** (single-tenant) |
| Admin app role | display **Watson Administrator**, value **`Watson.Admin`** |
| Admin assignment | the owner's verified account is assigned to `Watson.Admin` |
| App Service Authentication | Easy Auth v2, Microsoft Entra provider, **authentication required** |
| Unauthenticated action | `RedirectToLoginPage` (browsers → Entra sign-in; API clients → 401) |
| Client secret | generated in Entra, stored **only** in platform config (`MICROSOFT_PROVIDER_AUTHENTICATION_SECRET`); never in Git |

## Safety flags (verified live via `/api/health`)

```
{"status":"ok","authMode":"entra","liveReadGateEnabled":false,"liveExecutionEnabled":false,"reasonCodes":[]}
```

- `WATSON_AUTH_MODE=entra`, `WATSON_ADMIN_APP_ROLE=Watson.Admin`
- `IT_AGENT_GRAPH_LIVE_READONLY=false`, `IT_AGENT_LIVE_EXTERNAL_EXECUTION=false`
- No Graph/Key Vault app settings; no live remediation; no monitoring; no `NEXT_PUBLIC_*`.
- `IT_AGENT_PERSIST=off` (read-only package mount; mock cases are in-memory).

## Verified

- `/api/health` → 200, value-free.
- `/watson`, `/it-agent/cases`, `/it-agent/diagnostics`, `/api/it-agent/watson` → **blocked** unauthenticated (401 for API clients; **302 → Entra sign-in** for browsers).
- Deployed commit matches the tested SHA; 342/342 tests pass at that commit.

## Remaining (interactive; owner)

The signed-in browser pilot (owner + employee accounts) requires an interactive
Entra sign-in that cannot be performed headlessly — see the report and
`docs/PILOT_RUNBOOK.md`.

## Rollback

- **Disable app:** `az webapp stop -g watson-nonprod-rg -n watson-pilot-hrnp01`.
- **Roll back a bad redeploy:** redeploy the prior artifact / commit (run-from-package swap).
- **Disable auth if identity misconfigured:** `az webapp auth update -g watson-nonprod-rg -n watson-pilot-hrnp01 --enabled false`.
- **Remove admin assignment / abandon pilot:** delete the `Watson.Admin` app-role assignment, or delete the whole resource group `az group delete -n watson-nonprod-rg`.
- Live Graph and external execution stay disabled throughout; nothing to undo there.
- Do **not** delete infrastructure merely because one check fails — diagnose first.
