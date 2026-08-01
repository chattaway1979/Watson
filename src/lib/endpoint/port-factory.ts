// ============================================================
// Watson Remote IT Operator — endpoint port selection
// ------------------------------------------------------------
// DEFAULT is the labelled simulator. The real local-Windows adapter
// is used ONLY when explicitly enabled (WATSON_LOCAL_ENDPOINT_ENABLED
// = true) AND a valid non-production test-device marker is present;
// otherwise it fails closed and the simulator remains in effect.
// A request can never force a provider.
// ============================================================
import type { EndpointOperationsPort } from './contracts';
import { createSimulator } from './simulator';
import { createLocalWindowsAdapter, loadLocalAdapterConfig, type LocalAdapterDeps } from './adapters/local-windows';

export function getEndpointPort(env: NodeJS.ProcessEnv = process.env, deps?: LocalAdapterDeps): EndpointOperationsPort {
  const cfg = deps?.config ?? loadLocalAdapterConfig(env);
  if (cfg.enabled) {
    // The adapter still fails closed unless a valid non-prod marker is present.
    return createLocalWindowsAdapter({ ...deps, config: cfg });
  }
  return createSimulator();
}
