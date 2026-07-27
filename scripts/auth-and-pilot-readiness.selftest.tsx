/* ============================================================
 * Watson — H&R AI IT Agent : Production auth seam, readiness endpoint,
 * and administrator diagnostics UI self-tests. Invoked from
 * it-agent-selftest.ts. NO network, NO real Azure/Microsoft client:
 * Entra sessions are fabricated Easy-Auth principal headers, and UI is
 * rendered with react-dom/server (static markup).
 * ============================================================ */
import { renderToStaticMarkup } from 'react-dom/server';
import { listAudit } from '../src/lib/it-agent/audit';
import { listApprovals } from '../src/lib/it-agent/approval-engine';
import { isLiveExternalExecutionEnabled } from '../src/lib/it-agent/constants';
import {
  watsonAuthMode,
  actorFromRequestOrNull,
  actorFromEntra,
  getServerActor
} from '../src/lib/it-agent/session';
import { m365LiveReadiness, deploymentConfigValidation } from '../src/lib/it-agent/deployment';
import { GET as readinessGET } from '../src/app/api/it-agent/diagnostics/m365/readiness/route';
import { GET as diagGET } from '../src/app/api/it-agent/diagnostics/m365/route';
import { DiagnosticsResultCard, ReadinessBanner, type ReadinessView } from '../src/components/it-agent/DiagnosticsResultCard';
import { DiagnosticsClient } from '../src/components/it-agent/DiagnosticsClient';
import { roleAtLeast } from '../src/lib/it-agent/constants';
import type { M365DiagnosticOutcome, M365ReadKey } from '../src/lib/it-agent';

type Env = NodeJS.ProcessEnv;
const env = (o: Record<string, string>) => o as unknown as Env;
function principal(claims: Array<{ typ: string; val: string }>): string {
  return Buffer.from(JSON.stringify({ auth_typ: 'aad', claims })).toString('base64');
}
const hdr = (h: Record<string, string>) => new Request('http://localhost/x', { headers: h });

export async function runAuthAndPilotReadinessTests(): Promise<{ pass: number; fail: number; failures: string[] }> {
  let pass = 0;
  let fail = 0;
  const failures: string[] = [];
  const check = (name: string, cond: boolean, detail = '') => {
    if (cond) { pass++; console.log('  ✅ ' + name); }
    else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log('  ❌ ' + name + (detail ? ` — ${detail}` : '')); }
  };

  const TOKEN = 'BEARER-TOKEN-SECRET-DO-NOT-LOG';
  const SECRET = 'KV-CLIENT-SECRET-DO-NOT-LOG';
  const ADMIN_GROUP = 'group-obj-id-123';
  const ENTRA = { WATSON_AUTH_MODE: 'entra', WATSON_ADMIN_ENTRA_GROUP_ID: ADMIN_GROUP };

  // ================================================================
  console.log('\n[35] Authentication seam (demo vs entra)');
  // ================================================================
  check('auth mode defaults to demo', watsonAuthMode(env({})) === 'demo');
  check('auth mode entra when set', watsonAuthMode(env({ WATSON_AUTH_MODE: 'entra' })) === 'entra');
  check('auth mode malformed => demo', watsonAuthMode(env({ WATSON_AUTH_MODE: 'nope' })) === 'demo');

  // demo mode trusts the role switcher (dev/test only)
  check('demo mode resolves role header', actorFromRequestOrNull(hdr({ 'x-watson-role': 'admin' }), env({}))?.role === 'admin');
  // entra mode IGNORES demo role header/cookie
  check('entra mode ignores x-watson-role header', actorFromRequestOrNull(hdr({ 'x-watson-role': 'admin' }), env(ENTRA)) === null);
  check('entra mode ignores watson_role cookie', actorFromRequestOrNull(hdr({ cookie: 'watson_role=admin' }), env(ENTRA)) === null);
  // entra missing session => null (401 at route)
  check('entra missing principal => null', actorFromEntra(hdr({}).headers, env(ENTRA)) === null);
  // entra non-admin principal => employee
  const emp = actorFromEntra(hdr({ 'x-ms-client-principal': principal([{ typ: 'preferred_username', val: 'u@hre.com' }]) }).headers, env(ENTRA));
  check('entra principal without admin claim => employee', emp?.role === 'employee' && emp?.type === 'user');
  // entra admin group claim => admin
  const adm = actorFromEntra(hdr({ 'x-ms-client-principal': principal([{ typ: 'preferred_username', val: 'a@hre.com' }, { typ: 'groups', val: ADMIN_GROUP }]) }).headers, env(ENTRA));
  check('entra principal with admin group => admin', adm?.role === 'admin' && adm?.type === 'admin');
  // entra admin via app role
  const admRole = actorFromEntra(hdr({ 'x-ms-client-principal': principal([{ typ: 'email', val: 'a@hre.com' }, { typ: 'roles', val: 'Watson.Admin' }]) }).headers, env({ WATSON_AUTH_MODE: 'entra', WATSON_ADMIN_APP_ROLE: 'Watson.Admin' }));
  check('entra principal with admin app role => admin', admRole?.role === 'admin');
  // malformed principal => null
  check('entra malformed principal => null', actorFromEntra(hdr({ 'x-ms-client-principal': 'not-base64-json!!' }).headers, env(ENTRA)) === null);
  // no email claim => fail closed
  check('entra principal without email => null', actorFromEntra(hdr({ 'x-ms-client-principal': principal([{ typ: 'groups', val: ADMIN_GROUP }]) }).headers, env(ENTRA)) === null);
  // admin selector NOT configured => cannot be admin even with a group claim
  const noSel = actorFromEntra(hdr({ 'x-ms-client-principal': principal([{ typ: 'email', val: 'a@hre.com' }, { typ: 'groups', val: ADMIN_GROUP }]) }).headers, env({ WATSON_AUTH_MODE: 'entra' }));
  check('entra without admin selector => never admin (fail closed)', noSel?.role === 'employee');
  // users cannot assume agent/system/owner: mapping only yields admin|employee, type admin|user
  const spoof = actorFromEntra(hdr({ 'x-ms-client-principal': principal([{ typ: 'email', val: 'x@hre.com' }, { typ: 'roles', val: 'system' }, { typ: 'roles', val: 'owner' }]) }).headers, env(ENTRA));
  check('entra user cannot assume agent/system/owner', spoof !== null && (spoof.role === 'employee' || spoof.role === 'admin') && (spoof.type === 'user' || spoof.type === 'admin'));
  // actor object exposes no token/claim/secret fields
  check('resolved actor has no token/claim/secret fields', (() => { const keys = Object.keys(adm ?? {}); return keys.every((k) => ['id', 'type', 'role', 'email', 'displayName'].includes(k)); })());
  check('getServerActor is the mode-aware resolver', getServerActor === actorFromRequestOrNull);

  // ================================================================
  console.log('\n[36] Readiness endpoint (admin-only, value-free)');
  // ================================================================
  const savedEnv: Record<string, string | undefined> = {};
  const setEnv = (o: Record<string, string>) => { for (const [k, v] of Object.entries(o)) { savedEnv[k] = process.env[k]; process.env[k] = v; } };
  const restoreEnv = () => { for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };

  // Demo mode: no identity => 401; employee => 403; admin => 200
  const rNoAuth = await readinessGET(hdr({}));
  check('readiness: no identity => 401', rNoAuth.status === 401);
  const rEmp = await readinessGET(hdr({ 'x-watson-role': 'employee' }));
  check('readiness: employee => 403', rEmp.status === 403);
  const rAdmRes = await readinessGET(hdr({ 'x-watson-role': 'admin' }));
  const rAdm = await rAdmRes.json();
  check('readiness: admin => 200 mock (gate off, no Azure constructed)', rAdmRes.status === 200 && rAdm.data.connectorReadiness === 'mock');
  check('readiness: no-store header', rAdmRes.headers.get('cache-control') === 'no-store');

  // ready_for_live when full presence + gate on
  try {
    setEnv({ IT_AGENT_GRAPH_LIVE_READONLY: 'true', GRAPH_TENANT_ID: 't-123', GRAPH_CLIENT_ID: 'c-123', GRAPH_CLIENT_SECRET_KEYVAULT_REF: 'ref', AZURE_KEY_VAULT_URL: 'https://kv.vault.azure.net' });
    const rReady = await (await readinessGET(hdr({ 'x-watson-role': 'admin' }))).json();
    check('readiness: full presence + gate on => ready_for_live', rReady.data.connectorReadiness === 'ready_for_live');
    const dump = JSON.stringify(rReady);
    check('readiness: no tenant/client/vault/secret values escape', !dump.includes('t-123') && !dump.includes('c-123') && !dump.includes('kv.vault') && !dump.includes(SECRET) && !dump.includes(TOKEN));
    setEnv({ AZURE_KEY_VAULT_URL: '' });
    const rFail = await (await readinessGET(hdr({ 'x-watson-role': 'admin' }))).json();
    check('readiness: gate on but incomplete => fail_closed + safe codes', rFail.data.connectorReadiness === 'fail_closed' && rFail.data.reasonCodes.includes('keyvault_not_configured'));
  } finally { restoreEnv(); }

  // deploymentConfigValidation is value-free
  const dcv = deploymentConfigValidation(env({ WATSON_AUTH_MODE: 'entra', WATSON_ADMIN_APP_ROLE: 'Watson.Admin', GRAPH_TENANT_ID: 't-123' }));
  check('deploymentConfigValidation reports production-ready auth', dcv.authProductionReady === true);
  check('deploymentConfigValidation is value-free', !JSON.stringify(dcv).includes('t-123') && !JSON.stringify(dcv).includes('Watson.Admin'));

  // ================================================================
  console.log('\n[37] Administrator UI (pure render, no raw/secret, no writes)');
  // ================================================================
  const mkOutcome = (read: M365ReadKey, connector: 'mock' | 'live_readonly', data: unknown): M365DiagnosticOutcome =>
    ({ outcome: 'evidence', read, target: 'u@hre.com', connector, result: { source: connector === 'mock' ? 'mock' : 'graph', state: 'ok', data } } as M365DiagnosticOutcome);

  const mockCard = renderToStaticMarkup(<DiagnosticsResultCard outcome={mkOutcome('lookup_user', 'mock', { id: 'u1', email: 'u@hre.com', displayName: 'U', jobTitle: null, department: null, accountEnabled: true })} />);
  check('UI: mock evidence is labeled MOCK', /MOCK DATA/.test(mockCard));
  const liveCard = renderToStaticMarkup(<DiagnosticsResultCard outcome={mkOutcome('lookup_user', 'live_readonly', { id: 'u1', email: 'u@hre.com', displayName: 'U', jobTitle: null, department: null, accountEnabled: true })} />);
  check('UI: live evidence is labeled LIVE (not mock)', /LIVE \(read-only\)/.test(liveCard) && !/MOCK DATA/.test(liveCard));
  const notCfg = renderToStaticMarkup(<DiagnosticsResultCard outcome={{ outcome: 'not_configured', read: 'lookup_user', target: 'u@hre.com', reason: 'keyvault_not_configured' }} />);
  check('UI: not_configured shown honestly with code', /not configured/i.test(notCfg) && /keyvault_not_configured/.test(notCfg));

  // Render all five reads (proves the console can display each).
  const fiveReads = ['lookup_user', 'check_license_status', 'check_mfa_status', 'check_mailbox_status', 'check_group_membership'] as const;
  let fiveOk = true;
  for (const r of fiveReads) { try { renderToStaticMarkup(<DiagnosticsResultCard outcome={mkOutcome(r, 'mock', { email: 'u@hre.com' })} />); } catch { fiveOk = false; } }
  check('UI: renders all five diagnostics without error', fiveOk);

  // Raw Graph / secret fields never render from a normalized outcome.
  const cleanCard = renderToStaticMarkup(<DiagnosticsResultCard outcome={mkOutcome('lookup_user', 'live_readonly', { id: 'u1', email: 'u@hre.com', displayName: 'U', jobTitle: null, department: null, accountEnabled: true })} />);
  check('UI: no raw @odata/onPremises/token/secret in card', !cleanCard.includes('@odata') && !cleanCard.includes('onPremises') && !cleanCard.includes(TOKEN) && !cleanCard.includes(SECRET));

  // Readiness banner is value-free and shows codes.
  const banner = renderToStaticMarkup(<ReadinessBanner readiness={{ authMode: 'entra', liveReadGateEnabled: true, connectorReadiness: 'fail_closed', reasonCodes: ['keyvault_not_configured'] } as ReadinessView} />);
  check('UI: readiness banner renders state + codes', /fail_closed/.test(banner) && /keyvault_not_configured/.test(banner) && /entra/.test(banner));

  // The interactive console renders with NO write/remediation controls.
  const consoleMarkup = renderToStaticMarkup(<DiagnosticsClient />);
  // Deliberately specific write ACTIONS (avoids matching the HTML `disabled` attr).
  const WRITE_WORDS = /disable account|disable user|reset password|password reset|delete user|wipe device|remediat|assign license|approve request/i;
  check('UI: console exposes NO write/remediation controls', !WRITE_WORDS.test(consoleMarkup));
  check('UI: console offers the read-only run + five reads', /Run read-only diagnostics/.test(consoleMarkup) && /Group Membership/.test(consoleMarkup));

  // Page-level gate: a non-admin actor is not admin (page renders unauthorized).
  check('UI page gate: employee is not admin', !roleAtLeast('employee', 'admin'));
  check('UI page gate: admin passes', roleAtLeast('admin', 'admin'));

  // ================================================================
  console.log('\n[38] Safety & integration (no side effects, guardrails intact)');
  // ================================================================
  const apprBefore = listApprovals().length;
  const mockExecBefore = listAudit({ action: 'mock_action_executed', limit: 5000 }).length;
  // existing policy still authorizes the diagnostics route (employee denied)
  const empDiag = await diagGET(hdr({ 'x-watson-role': 'employee' }));
  check('diagnostics route still denies employee (policy authoritative)', empDiag.status === 403);
  // admin can run (demo mode, mock) — needs a valid read+target query
  const diagUrl = 'http://localhost/api/it-agent/diagnostics/m365?read=lookup_user&target=sarah.office@hrelectriccompany.com';
  const admDiag = await (await diagGET(new Request(diagUrl, { headers: { 'x-watson-role': 'admin' } }))).json();
  check('diagnostics route: admin gets mock evidence', admDiag.data?.outcome === 'evidence' && admDiag.data?.connector === 'mock');
  check('no approvals created by readiness/diagnostics', listApprovals().length === apprBefore);
  check('no mock_action_executed emitted', listAudit({ action: 'mock_action_executed', limit: 5000 }).length === mockExecBefore);
  check('general live external execution remains disabled', isLiveExternalExecutionEnabled() === false);
  const auditDump = JSON.stringify(listAudit({ limit: 5000 }));
  check('no token/secret sentinel in audit output', !auditDump.includes(TOKEN) && !auditDump.includes(SECRET));

  return { pass, fail, failures };
}
