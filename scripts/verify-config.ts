/* ============================================================
 * Watson — deployment configuration verifier.
 * Run: npm run verify:config
 * Prints ONLY safe presence booleans + reason codes (never values). Exits 1 when
 * the deployment is misconfigured (e.g. Entra mode without an admin selector) so
 * a CI/deploy step can gate on it. Makes NO Azure/Graph/network call.
 * ============================================================ */
import { deploymentConfigValidation, deploymentHealth } from '../src/lib/it-agent/deployment';

const health = deploymentHealth(process.env);
const validation = deploymentConfigValidation(process.env);

console.log('Watson deployment configuration check');
console.log('  authMode:              ', validation.authMode);
console.log('  authProductionReady:   ', validation.authProductionReady);
console.log('  adminSelectorConfigured:', validation.adminSelectorConfigured);
console.log('  liveReadGateEnabled:   ', health.liveReadGateEnabled);
console.log('  liveExecutionEnabled:  ', health.liveExecutionEnabled);
console.log('  connectorReadiness:    ', validation.m365.connectorReadiness);
console.log('  m365 config presence:  ', JSON.stringify(validation.m365.config));
console.log('  reasonCodes:           ', validation.reasonCodes.join(', ') || '(none)');
console.log('  healthy:               ', health.healthy);

if (!health.healthy) {
  console.error('\nFAIL: deployment is misconfigured. Reason codes:', health.reasonCodes.join(', '));
  process.exit(1);
}
if (validation.authMode === 'demo') {
  console.log('\nNOTE: auth mode is "demo" — for local dev/test only. Set WATSON_AUTH_MODE=entra for production.');
}
console.log('\nOK: configuration is coherent for the selected mode.');
process.exit(0);
