/* ============================================================
 * Watson — H&R AI IT Agent : /api/it-agent/diagnostics/m365 route
 * self-tests. Invoked from it-agent-selftest.ts. NO network and NO
 * real Graph/Azure/Key Vault client: the route wires no transport, so
 * it is mock-by-default. Tests drive the exported GET handler directly
 * with fabricated Requests and assert HTTP status + normalized body.
 * ============================================================ */
import { listAudit } from '../src/lib/it-agent/audit';
import { listApprovals } from '../src/lib/it-agent/approval-engine';
import { GET } from '../src/app/api/it-agent/diagnostics/m365/route';

const BASE = 'http://localhost/api/it-agent/diagnostics/m365';

async function call(query: string, headers?: Record<string, string>): Promise<{ status: number; body: { ok: boolean; data?: unknown; error?: string } }> {
  const res = await GET(new Request(BASE + query, { headers: headers ?? {} }));
  const body = await res.json();
  return { status: res.status, body };
}
async function callRes(query: string, headers?: Record<string, string>) {
  return GET(new Request(BASE + query, { headers: headers ?? {} }));
}
const ADMIN = { 'x-watson-role': 'admin' };

export async function runGraphDiagnosticsRouteTests(): Promise<{ pass: number; fail: number; failures: string[] }> {
  let pass = 0;
  let fail = 0;
  const failures: string[] = [];
  const check = (name: string, cond: boolean, detail = '') => {
    if (cond) { pass++; console.log('  ✅ ' + name); }
    else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log('  ❌ ' + name + (detail ? ` — ${detail}` : '')); }
  };

  const TOKEN_SENTINEL = 'BEARER-TOKEN-SECRET-DO-NOT-LOG';
  const SECRET_SENTINEL = 'KV-CLIENT-SECRET-DO-NOT-LOG';
  const user = 'sarah.office@hrelectriccompany.com';

  console.log('\n[25] M365 diagnostics route — auth & authorization');
  const unauth = await call('?read=lookup_user&target=' + user); // no identity header/cookie
  check('unauthenticated (no identity) => 401', unauth.status === 401 && unauth.body.ok === false);
  const emp = await call('?read=lookup_user&target=' + user, { 'x-watson-role': 'employee' });
  check('employee => 403', emp.status === 403 && emp.body.ok === false);
  const mgr = await call('?read=lookup_user&target=' + user, { 'x-watson-role': 'manager' });
  check('manager (below admin) => 403', mgr.status === 403);
  const agent = await call('?read=lookup_user&target=' + user, { 'x-watson-role': 'agent' });
  check('agent claim is not assumable => rejected (403)', agent.status === 403);
  const viaCookie = await call('?read=lookup_user&target=' + user, { cookie: 'watson_role=admin' });
  check('admin via watson_role cookie is accepted', viaCookie.status === 200);

  console.log('\n[26] M365 diagnostics route — input validation');
  check('missing read => 400', (await call('?target=' + user, ADMIN)).status === 400);
  check('unsupported read => 400', (await call('?read=bogus&target=' + user, ADMIN)).status === 400);
  check('non-read action name (disable_account) => 400 (no write reachable)', (await call('?read=disable_account&target=' + user, ADMIN)).status === 400);
  check('missing target => 400', (await call('?read=lookup_user', ADMIN)).status === 400);
  check('malformed target (not an email) => 400', (await call('?read=lookup_user&target=not-an-email', ADMIN)).status === 400);
  check('oversized target => 400', (await call('?read=lookup_user&target=' + ('a'.repeat(330) + '@y.com'), ADMIN)).status === 400);

  console.log('\n[27] M365 diagnostics route — authorized reads (mock by default)');
  const reads = ['lookup_user', 'check_license_status', 'check_mfa_status', 'check_mailbox_status', 'check_group_membership'];
  for (const r of reads) {
    const res = await call('?read=' + r + '&target=' + user, ADMIN);
    const data = res.body.data as { outcome?: string; connector?: string } | undefined;
    check(`admin ${r} => 200 evidence via mock`, res.status === 200 && data?.outcome === 'evidence' && data?.connector === 'mock');
  }
  // Response carries the normalized contract only — no raw Graph fields.
  const shape = await call('?read=lookup_user&target=' + user, ADMIN);
  const dump = JSON.stringify(shape.body);
  check('response is normalized (no @odata / onPremises / userPrincipalName)',
    !dump.includes('@odata') && !dump.includes('onPremises') && !dump.includes('userPrincipalName'));
  check('response carries a normalized ReadResult (source/state/data)', (() => {
    const d = shape.body.data as { result?: { source?: unknown; state?: unknown } } | undefined;
    return typeof d?.result?.source === 'string' && typeof d?.result?.state === 'string';
  })());
  const res200 = await callRes('?read=lookup_user&target=' + user, ADMIN);
  check('200 responses are no-store (no cross-user caching)', res200.headers.get('cache-control') === 'no-store');

  console.log('\n[28] M365 diagnostics route — no side effects / no leakage');
  const apprBefore = listApprovals().length;
  const mockExecBefore = listAudit({ action: 'mock_action_executed', limit: 5000 }).length;
  const apprReqBefore = listAudit({ action: 'approval_requested', limit: 5000 }).length;
  for (const r of reads) await call('?read=' + r + '&target=' + user, ADMIN);
  check('route creates no approvals', listApprovals().length === apprBefore);
  check('route emits no mock_action_executed', listAudit({ action: 'mock_action_executed', limit: 5000 }).length === mockExecBefore);
  check('route emits no approval_requested', listAudit({ action: 'approval_requested', limit: 5000 }).length === apprReqBefore);
  const auditDump = JSON.stringify(listAudit({ limit: 5000 }));
  const allBodies = JSON.stringify([unauth.body, emp.body, shape.body, res200 && 'res']);
  check('no token/secret sentinel in any response body', !allBodies.includes(TOKEN_SENTINEL) && !allBodies.includes(SECRET_SENTINEL));
  check('no token/secret sentinel in audit output', !auditDump.includes(TOKEN_SENTINEL) && !auditDump.includes(SECRET_SENTINEL));
  check('no Bearer/Authorization header value in audit', !/Bearer /i.test(auditDump));

  console.log('\n[29] M365 diagnostics route — mock default & live gate (fail-closed)');
  const savedGate = process.env.IT_AGENT_GRAPH_LIVE_READONLY;
  try {
    process.env.IT_AGENT_GRAPH_LIVE_READONLY = 'maybe'; // malformed
    const malformed = await call('?read=lookup_user&target=' + user, ADMIN);
    check('malformed live flag => mock evidence (strict truthiness)', malformed.status === 200 && (malformed.body.data as { connector?: string }).connector === 'mock');
    process.env.IT_AGENT_GRAPH_LIVE_READONLY = 'false';
    const off = await call('?read=lookup_user&target=' + user, ADMIN);
    check('live flag false => mock evidence', (off.body.data as { connector?: string }).connector === 'mock');
    process.env.IT_AGENT_GRAPH_LIVE_READONLY = 'true'; // gate on but route wires NO transport/config
    const live = await call('?read=lookup_user&target=' + user, ADMIN);
    check('live flag on but no transport/config => not_configured (fail-closed, no mock fallback)',
      live.status === 200 && (live.body.data as { outcome?: string }).outcome === 'not_configured');
  } finally {
    if (savedGate === undefined) delete process.env.IT_AGENT_GRAPH_LIVE_READONLY;
    else process.env.IT_AGENT_GRAPH_LIVE_READONLY = savedGate;
  }
  const restored = await call('?read=lookup_user&target=' + user, ADMIN);
  check('env restored => mock evidence again', restored.status === 200 && (restored.body.data as { connector?: string }).connector === 'mock');

  return { pass, fail, failures };
}
