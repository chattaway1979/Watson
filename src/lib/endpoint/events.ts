// ============================================================
// Watson Remote IT Operator — Append-only event store
// ------------------------------------------------------------
// The event stream is the single source of truth for a case.
// Events are immutable once appended. A redaction guard prevents
// secrets/tokens/passwords from ever entering the audit trail.
// ============================================================
import type { EndpointEvent, EndpointEventType, Authority } from './contracts';

const STREAM: EndpointEvent[] = [];
let seq = 0;

// Keys whose values must never be persisted to the event stream.
const FORBIDDEN_KEY = /pass(word)?|secret|token|cookie|authorization|bearer|credential|mfa|otp|apikey|api_key|clientsecret/i;

function redact(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data ?? {})) {
    if (FORBIDDEN_KEY.test(k)) {
      out[k] = '[REDACTED]';
      continue;
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redact(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function appendEvent(input: {
  caseId: string;
  tenantId: string;
  type: EndpointEventType;
  actorId: string;
  actorAuthority: Authority;
  deviceId?: string;
  data?: Record<string, unknown>;
}): EndpointEvent {
  seq += 1;
  const evt: EndpointEvent = {
    eventId: `evt_${seq.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    caseId: input.caseId,
    tenantId: input.tenantId,
    type: input.type,
    actorId: input.actorId,
    actorAuthority: input.actorAuthority,
    deviceId: input.deviceId,
    at: new Date().toISOString(),
    data: redact(input.data ?? {})
  };
  Object.freeze(evt);
  STREAM.push(evt);
  return evt;
}

export function eventsForCase(caseId: string): EndpointEvent[] {
  // Per-case isolation: only this case's events are returned.
  return STREAM.filter((e) => e.caseId === caseId);
}

export function eventsForTenant(tenantId: string): EndpointEvent[] {
  return STREAM.filter((e) => e.tenantId === tenantId);
}

export function allEvents(): readonly EndpointEvent[] {
  return STREAM;
}

// Test helper only.
export function __resetEventsForTests(): void {
  STREAM.length = 0;
  seq = 0;
}
