// ============================================================
// Watson — H&R AI IT Agent : Deployment configuration status (SERVER-ONLY)
// ------------------------------------------------------------
// Safe, value-free views of deployment readiness for operators. Every field is
// a boolean, an enum state, or a short reason CODE. This module NEVER returns or
// logs an actual value: no tenant/client id, secret reference, vault URL,
// managed-identity id, token, secret, or claim. It performs NO Azure/Graph/Key
// Vault calls and constructs NO Azure clients (mock mode stays inert).
// ============================================================
import { watsonAuthMode, type WatsonAuthMode } from './session';
import { graphLiveReadinessStatus } from './graph/graph-bootstrap';

export type ConnectorReadiness = 'mock' | 'ready_for_live' | 'fail_closed';

export interface M365LiveReadiness {
  authMode: WatsonAuthMode;
  liveReadGateEnabled: boolean;
  config: {
    tenantConfigured: boolean;
    clientConfigured: boolean;
    secretRefConfigured: boolean;
    keyVaultConfigured: boolean;
    graphConfigComplete: boolean;
    managedIdentitySelectorPresent: boolean;
  };
  connectorReadiness: ConnectorReadiness;
  reasonCodes: string[];
}

// Derived purely from presence booleans (graphLiveReadinessStatus) — no Azure
// client is constructed and no network call is made.
export function m365LiveReadiness(env: NodeJS.ProcessEnv = process.env): M365LiveReadiness {
  const g = graphLiveReadinessStatus(env);
  const reasonCodes: string[] = [];
  let connectorReadiness: ConnectorReadiness;

  if (!g.liveReadOnlyFlag) {
    connectorReadiness = 'mock';
    reasonCodes.push('live_read_gate_disabled');
  } else {
    if (!g.graphConfigComplete) reasonCodes.push('graph_config_incomplete');
    if (!g.keyVaultConfigured) reasonCodes.push('keyvault_not_configured');
    connectorReadiness = g.graphConfigComplete && g.keyVaultConfigured ? 'ready_for_live' : 'fail_closed';
  }

  return {
    authMode: watsonAuthMode(env),
    liveReadGateEnabled: g.liveReadOnlyFlag,
    config: {
      tenantConfigured: g.tenantConfigured,
      clientConfigured: g.clientConfigured,
      secretRefConfigured: g.secretRefConfigured,
      keyVaultConfigured: g.keyVaultConfigured,
      graphConfigComplete: g.graphConfigComplete,
      managedIdentitySelectorPresent: g.managedIdentitySelectorPresent
    },
    connectorReadiness,
    reasonCodes
  };
}

export interface DeploymentConfigValidation {
  authMode: WatsonAuthMode;
  authProductionReady: boolean;
  adminSelectorConfigured: boolean;
  m365: M365LiveReadiness;
  reasonCodes: string[];
}

// Whole-deployment presence check (auth + Graph). Codes flag what must be
// completed before production and before live-read enablement.
export function deploymentConfigValidation(env: NodeJS.ProcessEnv = process.env): DeploymentConfigValidation {
  const authMode = watsonAuthMode(env);
  const adminSelectorConfigured =
    Boolean(env.WATSON_ADMIN_ENTRA_GROUP_ID?.trim()) || Boolean(env.WATSON_ADMIN_APP_ROLE?.trim());
  const reasonCodes: string[] = [];
  if (authMode === 'demo') reasonCodes.push('auth_mode_demo_not_production');
  if (authMode === 'entra' && !adminSelectorConfigured) reasonCodes.push('admin_selector_missing');

  const m365 = m365LiveReadiness(env);
  return {
    authMode,
    authProductionReady: authMode === 'entra' && adminSelectorConfigured,
    adminSelectorConfigured,
    m365,
    reasonCodes: [...reasonCodes, ...m365.reasonCodes]
  };
}
