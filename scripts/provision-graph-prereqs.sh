#!/usr/bin/env bash
# ============================================================
# Watson — WATSON-GRAPH-PREREQUISITES-PROVISION-011A
# Provision the Microsoft Graph READ-ONLY prerequisites.
# ------------------------------------------------------------
# Provisions sections 1-6 of docs/GRAPH_LIVE_READONLY.md and STOPS.
# It NEVER sets IT_AGENT_GRAPH_LIVE_READONLY=true and NEVER enables
# external execution — both flags are explicitly written as false.
#
# Idempotent: safe to re-run. Each step checks for the existing object
# first, so a partial run can simply be re-run to completion.
#
# SECRET HANDLING: the Graph client secret is generated and piped
# straight into Key Vault. It is never echoed, logged, written to disk,
# or placed in an environment variable that outlives this script.
#
# NOTE: `az role ...` fails with MissingSubscription on Azure CLI 2.87.0
# in some environments (a CLI defect, not permissions). Role assignments
# below therefore use the ARM REST API, which works regardless.
# ============================================================
set -euo pipefail

APP_NAME="Watson Graph Read-Only (Non-Production)"
RG="watson-nonprod-rg"
LOCATION="southcentralus"
VAULT="watson-np-graph-kv"
SECRET_NAME="watson-graph-client-secret"
WEBAPP="watson-pilot-hrnp01"
GRAPH_APP_ID="00000003-0000-0000-c000-000000000000"

# The four read-only application permissions backing the five diagnostics.
GRAPH_PERMISSIONS=(
  "User.Read.All"
  "GroupMember.Read.All"
  "UserAuthenticationMethod.Read.All"
  "MailboxSettings.Read"
)

say() { printf '\n== %s\n' "$1"; }

SUB=$(az account show --query id -o tsv)
TENANT=$(az account show --query tenantId -o tsv)
GRAPH_SP=$(az ad sp show --id "$GRAPH_APP_ID" --query id -o tsv)
say "Subscription $SUB / tenant $TENANT"

# ---------- 1. App registration (app-only; separate from the login app) ----------
say "App registration: $APP_NAME"
APP_ID=$(az ad app list --filter "displayName eq '$APP_NAME'" --query "[0].appId" -o tsv)
if [ -z "$APP_ID" ]; then
  # Build the requiredResourceAccess manifest from the permission names above.
  ACCESS=$(az ad sp show --id "$GRAPH_APP_ID" --query \
    "appRoles[?value=='${GRAPH_PERMISSIONS[0]}' || value=='${GRAPH_PERMISSIONS[1]}' || value=='${GRAPH_PERMISSIONS[2]}' || value=='${GRAPH_PERMISSIONS[3]}'].{id:id,type:'Role'}" -o json)
  MANIFEST=$(printf '[{"resourceAppId":"%s","resourceAccess":%s}]' "$GRAPH_APP_ID" "$ACCESS")
  TMP=$(mktemp); printf '%s' "$MANIFEST" > "$TMP"
  APP_ID=$(az ad app create --display-name "$APP_NAME" --sign-in-audience AzureADMyOrg \
    --required-resource-accesses @"$TMP" --query appId -o tsv)
  rm -f "$TMP"
  echo "   created appId=$APP_ID"
else
  echo "   exists appId=$APP_ID"
fi

# ---------- 2. Service principal ----------
say "Service principal"
SP_ID=$(az ad sp list --filter "appId eq '$APP_ID'" --query "[0].id" -o tsv)
if [ -z "$SP_ID" ]; then
  SP_ID=$(az ad sp create --id "$APP_ID" --query id -o tsv)
  echo "   created spId=$SP_ID"
else
  echo "   exists spId=$SP_ID"
fi

# ---------- 3. Admin consent (explicit app role assignments) ----------
say "Admin consent — application permissions"
GRANTED=$(az rest --method GET \
  --url "https://graph.microsoft.com/v1.0/servicePrincipals/$SP_ID/appRoleAssignments" \
  --query "value[].appRoleId" -o tsv)
for PERM in "${GRAPH_PERMISSIONS[@]}"; do
  ROLE_ID=$(az ad sp show --id "$GRAPH_APP_ID" --query "appRoles[?value=='$PERM'].id | [0]" -o tsv)
  if printf '%s\n' "$GRANTED" | grep -qx "$ROLE_ID"; then
    echo "   already granted: $PERM"
  else
    az rest --method POST \
      --url "https://graph.microsoft.com/v1.0/servicePrincipals/$SP_ID/appRoleAssignments" \
      --headers "Content-Type=application/json" \
      --body "{\"principalId\":\"$SP_ID\",\"resourceId\":\"$GRAPH_SP\",\"appRoleId\":\"$ROLE_ID\"}" \
      -o none
    echo "   granted: $PERM"
  fi
done

# ---------- 4. Key Vault (RBAC-authorized) ----------
say "Key Vault: $VAULT"
if az keyvault show -n "$VAULT" -g "$RG" -o none 2>/dev/null; then
  echo "   exists"
else
  # Purge protection is IRREVERSIBLE once enabled — see docs/GRAPH_PREREQUISITES_011A.md §5.
  az keyvault create -n "$VAULT" -g "$RG" -l "$LOCATION" \
    --enable-rbac-authorization true --enable-purge-protection true --retention-days 7 -o none
  echo "   created"
fi
VAULT_URI="https://$VAULT.vault.azure.net"
VAULT_SCOPE="/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.KeyVault/vaults/$VAULT"

# ---------- 5. Managed identity on the web app ----------
say "Managed identity on $WEBAPP"
MI_PRINCIPAL=$(az webapp identity show -g "$RG" -n "$WEBAPP" --query principalId -o tsv 2>/dev/null || true)
if [ -z "$MI_PRINCIPAL" ] || [ "$MI_PRINCIPAL" = "null" ]; then
  MI_PRINCIPAL=$(az webapp identity assign -g "$RG" -n "$WEBAPP" --query principalId -o tsv)
  echo "   enabled principalId=$MI_PRINCIPAL"
else
  echo "   exists principalId=$MI_PRINCIPAL"
fi

# ---------- 6. Key Vault RBAC ----------
# Requires Owner/User Access Administrator on the vault scope. May be refused by
# a restricted automation context — if so, assign these two roles in the portal.
assign_role() {  # $1=principalId  $2=roleDefGuid  $3=principalType  $4=label
  local existing
  existing=$(az rest --method GET \
    --url "https://management.azure.com$VAULT_SCOPE/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&\$filter=principalId%20eq%20'$1'" \
    --query "value[?contains(properties.roleDefinitionId,'$2')] | length(@)" -o tsv 2>/dev/null || echo 0)
  if [ "${existing:-0}" != "0" ]; then echo "   already assigned: $4"; return 0; fi
  az rest --method PUT \
    --url "https://management.azure.com$VAULT_SCOPE/providers/Microsoft.Authorization/roleAssignments/$(cat /proc/sys/kernel/random/uuid 2>/dev/null || python -c 'import uuid;print(uuid.uuid4())')?api-version=2022-04-01" \
    --headers "Content-Type=application/json" \
    --body "{\"properties\":{\"roleDefinitionId\":\"/subscriptions/$SUB/providers/Microsoft.Authorization/roleDefinitions/$2\",\"principalId\":\"$1\",\"principalType\":\"$3\"}}" \
    -o none
  echo "   assigned: $4"
}

say "Key Vault RBAC"
KV_SECRETS_USER="4633458b-17de-408a-b874-0445c86b69e6"
KV_SECRETS_OFFICER="b86a8fe4-44ce-4948-aee5-eccb2c155cd7"
OPERATOR_ID=$(az ad signed-in-user show --query id -o tsv)
assign_role "$OPERATOR_ID"  "$KV_SECRETS_OFFICER" "User"           "operator -> Key Vault Secrets Officer"
assign_role "$MI_PRINCIPAL" "$KV_SECRETS_USER"    "ServicePrincipal" "web app MI -> Key Vault Secrets User"

# ---------- 7. Client secret -> Key Vault (value never surfaces) ----------
say "Client secret in Key Vault"
if az keyvault secret show --vault-name "$VAULT" --name "$SECRET_NAME" -o none 2>/dev/null; then
  echo "   secret already present — left untouched"
else
  # Generated and consumed in one shot. `-o none` on the vault write is what keeps
  # the value out of stdout; `az keyvault secret set` would otherwise print it.
  SECRET_VALUE=$(az ad app credential reset --id "$APP_ID" \
    --display-name "watson-graph-readonly" --years 1 --append --query password -o tsv)
  az keyvault secret set --vault-name "$VAULT" --name "$SECRET_NAME" \
    --value "$SECRET_VALUE" -o none
  unset SECRET_VALUE
  echo "   created and stored (value never printed)"
fi

# ---------- 8. Non-secret app settings; SAFETY FLAGS STAY FALSE ----------
say "App settings on $WEBAPP (live gate remains FALSE)"
az webapp config appsettings set -g "$RG" -n "$WEBAPP" --settings \
  GRAPH_TENANT_ID="$TENANT" \
  GRAPH_CLIENT_ID="$APP_ID" \
  GRAPH_CLIENT_SECRET_KEYVAULT_REF="$SECRET_NAME" \
  AZURE_KEY_VAULT_URL="$VAULT_URI" \
  IT_AGENT_GRAPH_LIVE_READONLY=false \
  IT_AGENT_LIVE_EXTERNAL_EXECUTION=false -o none
echo "   set (both safety flags written as false)"

# ---------- 9. Verify ----------
say "Verification"
az webapp config appsettings list -g "$RG" -n "$WEBAPP" \
  --query "[?starts_with(name,'GRAPH_') || starts_with(name,'AZURE_KEY') || starts_with(name,'IT_AGENT_')].{name:name,value:value}" -o table

cat <<'EOF'

Provisioning complete. Live Graph reads are NOT enabled.
  - IT_AGENT_GRAPH_LIVE_READONLY=false  -> connector resolves to mock
  - IT_AGENT_LIVE_EXTERNAL_EXECUTION=false
To enable live reads later, follow docs/GRAPH_LIVE_READONLY.md sections 8 and 10.
EOF
