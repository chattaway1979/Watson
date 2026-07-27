# Watson — Azure Deployment (non-production pilot)

Simplest hosting compatible with the existing auth seam: **Azure App Service
(Linux, Node)** behind **App Service Authentication (Easy Auth)** for Entra. The
app builds to a self-contained server via `output: 'standalone'`. No extra
infrastructure framework is required.

> All secrets live in Azure platform settings / Key Vault — **never in Git**.
> Placeholders below (`<...>`) are filled in only in the deployment environment.

## 1. Runtime & commands

| Setting | Value |
|---|---|
| Node | 22 LTS+ (`.nvmrc` = 24; `engines.node >= 22.11.0`) |
| Build | `npm ci && npm run build` |
| Start (standalone) | `node .next/standalone/server.js` |
| Health check path | `/api/health` (200 healthy, **503** when Entra config is incomplete) |
| Config gate (pre-deploy) | `npm run verify:config` (exits non-zero if misconfigured) |

After `next build` with `output: 'standalone'`, copy `.next/static` and `public`
next to `.next/standalone` (standard Next standalone packaging) so the server can
serve assets.

## 2. Environment contract (App Service application settings)

Required for the pilot (auth ON, live-read OFF):

```
WATSON_AUTH_MODE=entra
WATSON_ADMIN_ENTRA_GROUP_ID=<admin-group-object-id>   # or:
WATSON_ADMIN_APP_ROLE=<app-role-value>
IT_AGENT_GRAPH_LIVE_READONLY=false
IT_AGENT_LIVE_EXTERNAL_EXECUTION=false
```

Not needed for the mock pilot (only before a later live-read pilot — see
`docs/GRAPH_LIVE_READONLY.md`): `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`,
`GRAPH_CLIENT_SECRET_KEYVAULT_REF`, `AZURE_KEY_VAULT_URL`,
`AZURE_MANAGED_IDENTITY_CLIENT_ID`.

- **Never sent to the browser:** every variable above is server-only. No secret
  value is an app setting; the Graph client secret (later) resolves from Key
  Vault via managed identity.
- **Fail-closed:** with `WATSON_AUTH_MODE=entra` and no admin selector,
  `/api/health` returns **503** and `npm run verify:config` exits 1 — deploy
  gates should block until fixed. Demo mode boots with no Graph/Key Vault config.

## 3. App Service Authentication (Easy Auth)

1. Enable **Authentication** on the App Service; add the **Microsoft (Entra)**
   identity provider using the Watson login app registration.
2. Require authentication for all requests (unauthenticated → redirect to
   sign-in). This injects the verified `x-ms-client-principal` header and strips
   any client-supplied copy — the seam reads only that in entra mode.
3. Ensure the **groups**/**roles** claim is emitted so the admin group/app role
   reaches Watson.

## 4. Deploy sequence (placeholders)

```
# 0) gate
npm ci
npm run verify:config            # must pass for the target env
npm run it-agent:selftest        # 342 tests, all green
npm run build

# 1) deploy the EXACT tested commit to the NON-PRODUCTION app
az webapp deploy \
  --resource-group <rg> \
  --name <nonprod-app-name> \
  --src-path <artifact.zip> --type zip

# 2) set app settings (auth ON, live-read OFF) via portal or:
az webapp config appsettings set -g <rg> -n <nonprod-app-name> --settings \
  WATSON_AUTH_MODE=entra WATSON_ADMIN_APP_ROLE=<role> \
  IT_AGENT_GRAPH_LIVE_READONLY=false IT_AGENT_LIVE_EXTERNAL_EXECUTION=false

# 3) confirm
curl -s https://<nonprod-app-host>/api/health   # expect {"status":"ok","authMode":"entra",...}
```

Confirm the deployed commit matches the tested SHA before running the pilot.

## 5. Rollback

- **Config rollback (instant):** set `IT_AGENT_GRAPH_LIVE_READONLY=false` (already
  false in the pilot) and/or `WATSON_AUTH_MODE=demo` is **not** used in
  production. To disable the app, stop the App Service or swap to the previous
  deployment slot.
- **Deployment rollback:** redeploy the previous artifact/commit, or swap back
  the staging slot. No data migration is involved (mock/in-memory store).

## 6. What stays OFF in this pilot

Live Graph reads, live external execution, real remediation, real Intune/
Defender/Apple-MDM/Key-Vault/voice-provider/endpoint calls, and proactive
security monitoring are all disabled. Watson is mock-by-default and makes no
tenant change.
