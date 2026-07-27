export * from './types';
export * from './constants';
export * as registry from './action-registry';
export * from './policy';
export * from './audit';
export * from './tickets';
export * from './knowledge';
export * from './triage';
export * from './troubleshooting';
export * from './approval-engine';
export * from './tool-gateway';
export * from './ai-provider';
export * from './deterministic-agent';
export { seedAll } from './seed-knowledge';
export { mockM365, connectorStatus } from './mock-microsoft365';
export { mockDevice, deviceConnectorStatus } from './mock-device-management';
// Server-only read-only Microsoft 365 diagnostics (mock by default; live gated).
export {
  runM365Diagnostic,
  resolveM365ReadOnlyConnector,
  type M365ReadKey,
  type M365DiagnosticOutcome,
  type M365ConnectorResolution,
  type ResolvedConnector
} from './graph/graph-diagnostics';
