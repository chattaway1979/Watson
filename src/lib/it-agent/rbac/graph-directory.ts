// ============================================================
// Watson — 021D : Graph-backed employee directory for RBAC (SERVER-ONLY)
// ------------------------------------------------------------
// Closes the largest gap from 021C-2: the RBAC administrator could only search a
// hardcoded fixture list, so real employees were undiscoverable and a role could
// only be granted by pasting an object id.
//
// This module performs a READ-ONLY Microsoft Graph lookup using the App Service
// SYSTEM-ASSIGNED MANAGED IDENTITY. It is deliberately narrow:
//
//   * GET /users only. No write verb exists on the transport it uses.
//   * The only application permission required is User.Read.All, which the
//     identity already holds. Nothing here requests or needs more.
//   * The client never supplies OData. The query is sanitised to a conservative
//     character set and embedded in a server-built $search expression, so a
//     caller cannot inject a filter, expand a $select, or redirect the request.
//   * Nothing derived from Microsoft state (roles, groups, licences, job title,
//     department) influences Watson authorisation. Graph supplies *who exists*,
//     never *what they may do* — Watson roles remain application-only.
//   * PROVENANCE IS EARNED, NOT CONFIGURED. `graph_live` is returned only when a
//     real Graph 200 response was parsed successfully. Every other outcome is an
//     explicit, safe failure — mock rows are never presented as live tenant data.
//   * No token, Graph error body, tenant identifier, claim or stack trace is
//     returned to a caller or logged.
// ============================================================
import type { DirectoryEntry, DirectorySource } from './service';
import { sanitizeDirectoryText } from './service';
import type { GraphHttpClient } from '../graph/graph-config';
import { loadManagedIdentityGraphConfig, isGraphLiveReadOnlyEnabled } from '../graph/graph-config';
import { createManagedIdentityTokenProvider, createManagedIdentityGraphHttpClient } from '../graph/graph-managed-identity';

// Matches the RBAC search contract already enforced by the security core.
export const DIRECTORY_MIN_QUERY = 3;
export const DIRECTORY_MAX_RESULTS = 25;

// Why a live lookup could not be served. Every value is a safe category — never
// a Graph message, status text, or exception string.
export type DirectoryUnavailableReason =
  | 'live_gate_disabled'
  | 'token_unavailable'
  | 'graph_unauthorized'
  | 'graph_throttled'
  | 'graph_unavailable'
  | 'graph_malformed_response'
  | 'query_too_short';

export type DirectoryLookup =
  | { ok: true; source: DirectorySource }
  | { ok: false; reason: DirectoryUnavailableReason };

// ------------------------------------------------------------
// Query safety.
//
// The sanitised query is embedded inside a double-quoted Graph $search term. We
// therefore reduce it to a conservative allow-list: letters, digits, space and
// the punctuation that legitimately appears in names and addresses. A double
// quote or backslash cannot survive, so the search expression cannot be closed
// or escaped, and no OData operator can be smuggled in.
// ------------------------------------------------------------
export function sanitizeDirectoryQuery(raw: unknown): string {
  return sanitizeDirectoryText(raw)
    .replace(/[^A-Za-z0-9 ._@'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64);
}

// Build the Graph request path. Server-constructed in full: the caller supplies
// only the sanitised search term, never any part of the OData syntax.
export function buildUserSearchPath(sanitizedQuery: string): string {
  const term = sanitizedQuery.replace(/"/g, ''); // belt and braces; already stripped
  const search = [
    `"displayName:${term}"`,
    `"userPrincipalName:${term}"`,
    `"mail:${term}"`
  ].join(' OR ');
  const params = [
    `$search=${encodeURIComponent(search)}`,
    `$select=${encodeURIComponent('id,displayName,userPrincipalName,mail,accountEnabled')}`,
    `$top=${DIRECTORY_MAX_RESULTS}`,
    '$count=true'
  ].join('&');
  return `/users?${params}`;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface GraphUser {
  id?: unknown;
  displayName?: unknown;
  userPrincipalName?: unknown;
  mail?: unknown;
  accountEnabled?: unknown;
}

// Map a Graph payload into the RBAC directory shape.
//
// Returns null when the response is not recognisably a Graph user collection, so
// a malformed or hostile body becomes an explicit failure rather than an empty
// result that would look like "no such employee".
export function mapGraphUsers(body: unknown): DirectoryEntry[] | null {
  if (!body || typeof body !== 'object') return null;
  const value = (body as { value?: unknown }).value;
  if (!Array.isArray(value)) return null;

  const out: DirectoryEntry[] = [];
  for (const raw of value as GraphUser[]) {
    if (!raw || typeof raw !== 'object') continue;
    const oid = typeof raw.id === 'string' ? raw.id.trim().toLowerCase() : '';
    // A row without a well-formed immutable object id is unusable as a role
    // target and is dropped rather than shown as selectable.
    if (!GUID.test(oid)) continue;

    const upn = sanitizeDirectoryText(raw.userPrincipalName ?? raw.mail ?? '');
    const displayName = sanitizeDirectoryText(raw.displayName ?? upn);
    if (!displayName && !upn) continue;

    // Disabled accounts are excluded: granting Watson access to an account that
    // cannot sign in is never the intent, and showing it invites a mistake.
    if (raw.accountEnabled === false) continue;

    out.push({ oid, displayName: displayName || upn, upn });
    if (out.length >= DIRECTORY_MAX_RESULTS) break;
  }
  return out;
}

// Classify a Graph HTTP status into a safe reason. The response body is never
// inspected for messaging and never propagated.
function reasonForStatus(status: number): DirectoryUnavailableReason {
  if (status === 401 || status === 403) return 'graph_unauthorized';
  if (status === 429) return 'graph_throttled';
  if (status >= 500) return 'graph_unavailable';
  return 'graph_unavailable';
}

export interface GraphDirectoryDeps {
  env?: NodeJS.ProcessEnv;
  // Injected by tests; production builds the managed-identity transport.
  httpClient?: GraphHttpClient;
}

// ------------------------------------------------------------
// The live lookup. Fails closed on every abnormal path.
// ------------------------------------------------------------
export async function lookupEmployeesViaGraph(
  queryRaw: unknown,
  deps: GraphDirectoryDeps = {}
): Promise<DirectoryLookup> {
  const env = deps.env ?? process.env;

  // The gate is checked first and is absolute: with it off no token is acquired
  // and no Graph request is made.
  if (!isGraphLiveReadOnlyEnabled(env)) return { ok: false, reason: 'live_gate_disabled' };

  const q = sanitizeDirectoryQuery(queryRaw);
  if (q.length < DIRECTORY_MIN_QUERY) return { ok: false, reason: 'query_too_short' };

  const config = loadManagedIdentityGraphConfig(env);
  const http = deps.httpClient
    ?? createManagedIdentityGraphHttpClient(config, createManagedIdentityTokenProvider(env));

  let token: string;
  try {
    token = await http.getToken();
    if (!token) return { ok: false, reason: 'token_unavailable' };
  } catch {
    // No identity endpoint, IMDS unreachable, permission denied. The underlying
    // error can echo environment detail, so it is deliberately not surfaced.
    return { ok: false, reason: 'token_unavailable' };
  }

  let status: number;
  let body: unknown;
  try {
    // ConsistencyLevel: eventual is required by Graph for $search on /users.
    const res = await http.get(buildUserSearchPath(q), token, { ConsistencyLevel: 'eventual' });
    status = res.status;
    body = res.body;
  } catch {
    // Timeout / abort / network failure / non-Graph host refusal.
    return { ok: false, reason: 'graph_unavailable' };
  }

  if (status !== 200) return { ok: false, reason: reasonForStatus(status) };

  const entries = mapGraphUsers(body);
  if (entries === null) return { ok: false, reason: 'graph_malformed_response' };

  // Only here — a real 200 whose body parsed as a Graph user collection — may the
  // result be described as live tenant data.
  return { ok: true, source: { provenance: 'graph_live', entries } };
}
