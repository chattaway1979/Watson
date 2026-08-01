// ============================================================
// Watson Remote IT Operator — Request Authorization + Replay
// ------------------------------------------------------------
// Transport/identity gate that sits IN FRONT OF the action policy.
// It binds every operation to: an allowlisted test device, a
// non-production environment, an unexpired window, a single-use
// nonce (replay protection), and a verified signature. It HARD-
// BLOCKS real execution when only a test-fixture signer is present
// or when live signing is not configured. Deny-by-default.
//
// Layering:  authorizeOperation()  ->  policy.canPerformAction()  ->  executor
// ============================================================

export interface OperationRequest {
  caseId: string;
  operationId: string;
  actionId: string;
  parameters: Record<string, unknown>;
  requesterId: string;
  approverId: string;
  approvalId?: string;
  deviceId: string;
  environment: string;    // MUST be 'nonproduction'
  issuedAt: string;       // ISO
  expiresAt: string;      // ISO
  nonce: string;          // single-use
  correlationId: string;
  softwareVersion: string;
  signature?: string;     // over the canonical payload
}

export interface EndpointAuthzConfig {
  allowedDeviceIds: string[];
  environment: string;          // runtime environment; must be 'nonproduction'
  killSwitchActive: boolean;
  liveSigningConfigured: boolean; // false => real execution is hard-blocked
}

export function loadEndpointAuthzConfig(env: NodeJS.ProcessEnv = process.env): EndpointAuthzConfig {
  const ids = (env.WATSON_ENDPOINT_ALLOWED_DEVICE_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    allowedDeviceIds: ids,
    environment: (env.WATSON_ENDPOINT_ENVIRONMENT ?? 'nonproduction').toLowerCase(),
    killSwitchActive: (env.WATSON_ENDPOINT_KILL_SWITCH ?? 'false').toLowerCase() === 'true',
    liveSigningConfigured: (env.WATSON_ENDPOINT_LIVE_SIGNING ?? 'false').toLowerCase() === 'true'
  };
}

// Signature verification is injected. The real verifier validates a live key;
// the test fixture is deterministic and MUST be refused for real execution.
export interface RequestVerifier {
  readonly id: string;
  readonly isTestFixture: boolean;
  verify(canonical: string, signature: string): boolean;
}

// Deterministic test-only verifier. isTestFixture = true so runtime refuses it.
export function createTestFixtureVerifier(sharedSecret = 'TEST-FIXTURE-KEY'): RequestVerifier {
  return {
    id: 'test-fixture', isTestFixture: true,
    verify(canonical, signature) { return signature === testSignature(canonical, sharedSecret); }
  };
}
export function testSignature(canonical: string, sharedSecret = 'TEST-FIXTURE-KEY'): string {
  // Non-cryptographic, deterministic — for tests ONLY.
  let h = 2166136261;
  const s = sharedSecret + '|' + canonical;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return 'testsig:' + (h >>> 0).toString(16);
}

// Canonical, signature-excluded serialization (stable field order).
export function canonicalize(req: OperationRequest): string {
  const o = {
    caseId: req.caseId, operationId: req.operationId, actionId: req.actionId, parameters: req.parameters,
    requesterId: req.requesterId, approverId: req.approverId, approvalId: req.approvalId ?? null,
    deviceId: req.deviceId, environment: req.environment, issuedAt: req.issuedAt, expiresAt: req.expiresAt,
    nonce: req.nonce, correlationId: req.correlationId, softwareVersion: req.softwareVersion
  };
  return JSON.stringify(o, Object.keys(o).sort());
}

const USED_NONCES = new Set<string>();
export function __resetNoncesForTests(): void { USED_NONCES.clear(); }

export type AuthzCategory =
  | 'authorized' | 'kill_switch_active' | 'unsupported_environment' | 'device_not_allowlisted'
  | 'malformed_request' | 'expired' | 'not_yet_valid' | 'missing_signature' | 'invalid_signature'
  | 'live_signing_required' | 'test_key_in_runtime' | 'replay_detected';

export interface AuthzDecision { authorized: boolean; reason: string; category: AuthzCategory; }

export interface AuthorizeOptions { realExecution: boolean; now?: number; }

export function authorizeOperation(
  req: OperationRequest,
  config: EndpointAuthzConfig,
  verifier: RequestVerifier,
  opts: AuthorizeOptions
): AuthzDecision {
  const now = opts.now ?? Date.now();

  if (config.killSwitchActive) return deny('kill switch active', 'kill_switch_active');

  // Structural completeness.
  const required: (keyof OperationRequest)[] = ['caseId', 'operationId', 'actionId', 'requesterId', 'approverId', 'deviceId', 'environment', 'issuedAt', 'expiresAt', 'nonce', 'correlationId', 'softwareVersion'];
  for (const k of required) { if (!req[k]) return deny(`missing field '${String(k)}'`, 'malformed_request'); }

  // Environment must be non-production on BOTH the request and the runtime.
  if (config.environment !== 'nonproduction' || req.environment.toLowerCase() !== 'nonproduction') {
    return deny('environment is not non-production', 'unsupported_environment');
  }

  // Device must be explicitly allowlisted.
  if (!config.allowedDeviceIds.includes(req.deviceId)) return deny('device not allowlisted', 'device_not_allowlisted');

  // Time window.
  const issued = Date.parse(req.issuedAt); const expires = Date.parse(req.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) return deny('invalid timestamps', 'malformed_request');
  if (now > expires) return deny('authorization expired', 'expired');
  if (issued - 60_000 > now) return deny('authorization not yet valid', 'not_yet_valid');

  // Signature.
  if (!req.signature) return deny('signature missing', 'missing_signature');
  if (!verifier.verify(canonicalize(req), req.signature)) return deny('signature invalid', 'invalid_signature');

  // Real execution hard-blocks: never with a test fixture, never without live signing.
  if (opts.realExecution) {
    if (verifier.isTestFixture) return deny('test signer refused at runtime', 'test_key_in_runtime');
    if (!config.liveSigningConfigured) return deny('live signing not configured', 'live_signing_required');
  }

  // Replay: single-use nonce (consumed only once all other checks pass).
  if (USED_NONCES.has(req.nonce)) return deny('replayed request', 'replay_detected');
  USED_NONCES.add(req.nonce);

  return { authorized: true, reason: 'authorized', category: 'authorized' };
}

function deny(reason: string, category: AuthzCategory): AuthzDecision { return { authorized: false, reason, category }; }
