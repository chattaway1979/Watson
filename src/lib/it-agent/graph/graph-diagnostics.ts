// ============================================================
// Watson — H&R AI IT Agent : Server-side M365 read-only diagnostics
// ------------------------------------------------------------
// A SERVER-ONLY diagnostic caller that runs the existing read-only
// Microsoft 365 checks through the connector factory. It is READ-ONLY
// and DIAGNOSTIC: it never invokes remediation, never changes approval
// state, never executes writes, and never enables live writes.
//
// Safety model preserved here:
//   * Mock connector is the DEFAULT. Live Graph reads happen only when the
//     full live gate is satisfied (see resolveM365ReadOnlyConnector).
//   * Authorization reuses the SAME policy the tool-gateway uses
//     (canPerformAction). This module does NOT define a second authz system.
//   * The result is a NORMALIZED ReadResult<T> (domain model) — raw Graph
//     payloads never leave the Graph adapter.
//   * Missing / denied / unavailable / malformed / partial evidence is
//     represented honestly and is NEVER treated as proof of health.
//   * Audit records carry the read key + outcome STATE only — never secrets,
//     tokens, headers, or raw payloads.
//
// This module is server-only: it reads process.env and (in live mode) drives
// a server-side HTTP transport. It must not be imported by client components.
// ============================================================
import type { Actor } from '../types';
import { canPerformAction } from '../policy';
import { writeAudit } from '../audit';
import type { GraphConfig, GraphHttpClient, SecretProvider } from './graph-config';
import {
  loadGraphConfig,
  isGraphLiveReadOnlyEnabled,
  createDefaultGraphHttpClient
} from './graph-config';
import type {
  M365ReadOnlyConnector,
  ReadResult
} from './graph-microsoft365';
import {
  getM365ReadOnlyConnector,
  mockReadOnlyConnector
} from './graph-microsoft365';

// The five read-only M365 diagnostics. Each key is ALSO an action-registry key,
// so authorization is enforced by the same policy the tool-gateway uses.
export type M365ReadKey =
  | 'lookup_user'
  | 'check_license_status'
  | 'check_mfa_status'
  | 'check_mailbox_status'
  | 'check_group_membership';

// Injection seams. Everything is optional so the default (no args) yields the
// mock connector with zero configuration and zero network.
export interface M365ConnectorResolution {
  env?: NodeJS.ProcessEnv;
  // Resolves the client secret from Key Vault (live mode only).
  secretProvider?: SecretProvider;
  // Direct transport injection (tests / an already-built bootstrap client).
  http?: GraphHttpClient;
  // Builds the transport from resolved config + secret (defaults to the real
  // client). Tests inject a fake so no network occurs.
  httpClientFactory?: (config: GraphConfig, secret: string) => GraphHttpClient;
}

export type ResolvedConnector =
  | { mode: 'mock'; connector: M365ReadOnlyConnector }
  | { mode: 'live_readonly'; connector: M365ReadOnlyConnector }
  | { mode: 'fail_closed'; reason: string };

// ------------------------------------------------------------
// Connector resolution / the live read-only GATE.
// Mock is the intended default. Live reads require EVERY condition:
//   1) IT_AGENT_GRAPH_LIVE_READONLY is truthy,
//   2) complete Graph config (tenant/client/secret-ref),
//   3) a transport — either injected directly, OR a SecretProvider that
//      resolves a non-empty secret from which the transport is built,
//   4) the existing factory yields a live connector.
// Any missing / ambiguous requirement while live is REQUESTED fails closed —
// it never silently downgrades to a partially configured live client, and never
// silently uses mock when live was explicitly requested.
// ------------------------------------------------------------
export async function resolveM365ReadOnlyConnector(
  opts: M365ConnectorResolution = {}
): Promise<ResolvedConnector> {
  const env = opts.env ?? process.env;

  // Gate OFF => live was NOT requested => mock is the intended default (not a
  // fallback). This is the normal, safe path.
  if (!isGraphLiveReadOnlyEnabled(env)) {
    return { mode: 'mock', connector: mockReadOnlyConnector };
  }

  // Gate ON => live is explicitly requested. From here, any gap fails closed.
  const config = loadGraphConfig(env);
  if (!config) {
    return { mode: 'fail_closed', reason: 'Live read-only requested but Graph configuration is incomplete.' };
  }

  // Resolve the transport strictly.
  let http = opts.http ?? null;
  if (!http) {
    if (!opts.secretProvider) {
      return { mode: 'fail_closed', reason: 'Live read-only requested but no transport or SecretProvider was supplied.' };
    }
    let secret: string | null = null;
    try {
      secret = await opts.secretProvider.getSecret(config.clientSecretRef);
    } catch {
      // SecretProvider itself already fails closed; treat any throw as fail-closed too.
      return { mode: 'fail_closed', reason: 'Client secret could not be resolved.' };
    }
    if (!secret) {
      return { mode: 'fail_closed', reason: 'Live read-only requested but the client secret could not be resolved.' };
    }
    const factory = opts.httpClientFactory ?? createDefaultGraphHttpClient;
    http = factory(config, secret);
  }

  // Build through the EXISTING factory (never construct Graph clients directly here).
  const connector = getM365ReadOnlyConnector({ env, http });
  if (connector.mode !== 'live_readonly') {
    // Defense-in-depth: refuse to hand back mock when live was explicitly requested.
    return { mode: 'fail_closed', reason: 'Live connector could not be constructed safely.' };
  }
  return { mode: 'live_readonly', connector };
}

// ------------------------------------------------------------
// Diagnostic outcome. A discriminated union that layers the authorization /
// gate decision on top of the connector's normalized ReadResult<T>.
//   * 'denied'         — actor is not authorized (or the read would require
//                        approval); NO read is performed.
//   * 'not_configured' — live was required/requested but cannot be safely built.
//   * 'evidence'       — a normalized ReadResult (mock or live). Its own `state`
//                        distinguishes ok / not_found / unavailable / unknown,
//                        and partial data is preserved honestly.
// ------------------------------------------------------------
export type M365DiagnosticOutcome =
  | { outcome: 'denied'; read: M365ReadKey; target: string; reason: string }
  | { outcome: 'not_configured'; read: M365ReadKey; target: string; reason: string }
  | { outcome: 'evidence'; read: M365ReadKey; target: string; connector: 'mock' | 'live_readonly'; result: ReadResult<unknown> };

async function performRead(
  connector: M365ReadOnlyConnector,
  read: M365ReadKey,
  target: string,
  actor: Actor
): Promise<ReadResult<unknown>> {
  switch (read) {
    case 'lookup_user': return connector.lookupUser(target, actor);
    case 'check_license_status': return connector.checkLicenseStatus(target, actor);
    case 'check_mfa_status': return connector.checkMfaStatus(target, actor);
    case 'check_mailbox_status': return connector.checkMailboxStatus(target, actor);
    case 'check_group_membership': return connector.checkGroupMembership(target, actor);
  }
}

// Run one read-only M365 diagnostic for `actor` against `target` (an email/UPN).
// `requireLive` makes the caller's intent explicit: when true, a resolution that
// is not a live connector fails closed instead of using mock.
export async function runM365Diagnostic(
  actor: Actor,
  read: M365ReadKey,
  target: string,
  // `connector` lets a server caller (e.g. the production bootstrap) supply an
  // already-resolved connector instead of resolving from env here. `requireLive`
  // makes the caller's live intent explicit.
  opts: M365ConnectorResolution & { requireLive?: boolean; connector?: ResolvedConnector } = {}
): Promise<M365DiagnosticOutcome> {
  // 1) Authorize through the SAME policy the tool-gateway enforces. A read that
  //    is not allowed — or that (defensively) would require approval — is never
  //    performed. This is why diagnostics cannot bypass authorization/approval.
  const decision = canPerformAction(actor, read, target);
  if (!decision.allowed || decision.requiresApproval) {
    writeAudit({
      actorType: actor.type,
      actorId: actor.id,
      action: 'diagnostic_read_denied',
      targetType: 'microsoft365',
      targetId: target,
      metadata: { read, allowed: decision.allowed, requiresApproval: decision.requiresApproval, reason: decision.reason }
    });
    return { outcome: 'denied', read, target, reason: decision.reason };
  }

  // 2) Resolve the connector: use a pre-resolved one if the caller supplied it
  //    (the production bootstrap does), else resolve from env (mock by default;
  //    live only when fully gated).
  const resolved = opts.connector ?? await resolveM365ReadOnlyConnector(opts);
  if (resolved.mode === 'fail_closed') {
    writeAudit({
      actorType: actor.type,
      actorId: actor.id,
      action: 'diagnostic_read_denied',
      targetType: 'microsoft365',
      targetId: target,
      metadata: { read, failClosed: true, reason: resolved.reason }
    });
    return { outcome: 'not_configured', read, target, reason: resolved.reason };
  }
  if (opts.requireLive && resolved.mode !== 'live_readonly') {
    writeAudit({
      actorType: actor.type,
      actorId: actor.id,
      action: 'diagnostic_read_denied',
      targetType: 'microsoft365',
      targetId: target,
      metadata: { read, requireLive: true, resolved: resolved.mode }
    });
    return { outcome: 'not_configured', read, target, reason: 'Live read-only was required but is unavailable; refusing to use mock.' };
  }

  // 3) Perform the read → NORMALIZED ReadResult<T> (never a raw Graph payload).
  const result = await performRead(resolved.connector, read, target, actor);

  // 4) Audit the diagnostic outcome — evidence STATE only. No payload, no secret.
  writeAudit({
    actorType: actor.type,
    actorId: actor.id,
    action: 'diagnostic_read_performed',
    targetType: 'microsoft365',
    targetId: target,
    metadata: { read, connector: resolved.mode, source: result.source, state: result.state, hasData: result.data !== null }
  });

  return { outcome: 'evidence', read, target, connector: resolved.mode, result };
}
