/* ============================================================
 * Watson — browser-pilot defect fixes (deterministic, network-free).
 *  1) Mock identity: an authenticated pilot user whose email is NOT in the fixed
 *     seed set still gets a healthy mock profile, so scenarios demonstrate the
 *     resolve/approve flow instead of always escalating.
 *  2) Entra mode: the session contract signals authMode=entra with no demo
 *     identities, so the client hides the demo role switcher.
 * ============================================================ */
import { startCase } from '../src/lib/it-agent';
import { GET as sessionGET } from '../src/app/api/it-agent/session/route';
import type { Actor } from '../src/lib/it-agent/types';

function principal(claims: Array<{ typ: string; val: string }>): string {
  return Buffer.from(JSON.stringify({ auth_typ: 'aad', claims })).toString('base64');
}

export async function runPilotFixTests(): Promise<{ pass: number; fail: number; failures: string[] }> {
  let pass = 0, fail = 0; const failures: string[] = [];
  const check = (name: string, cond: boolean, detail = '') => {
    if (cond) { pass++; console.log('  ✅ ' + name); }
    else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log('  ❌ ' + name + (detail ? ` — ${detail}` : '')); }
  };

  console.log('\n[51] Browser-pilot fixes');

  // 1) An UNSEEDED authenticated user now resolves (mock identity ensured).
  const newUser: Actor = { id: 'entra:pilot-new', type: 'user', role: 'employee', email: 'pilot.brandnew@hrelectriccompany.com', displayName: 'Pilot New' };
  const t = await startCase(newUser, 'Outlook keeps asking me to sign in on my windows laptop');
  check('unseeded pilot user resolves to a proposal (not auto-escalate)', t.case.state === 'waiting_for_approval' && !t.case.escalation.escalated);
  check('unseeded pilot user gets healthy evidence + high confidence', t.case.confidence === 'high' && t.case.hypotheses.find((h) => h.primary)?.strength === 'strongly_indicated');
  check('proposed employee-approvable repair present', t.case.proposedSolution?.approvalLevel === 'employee' && Boolean(t.case.proposedSolution?.title));

  // A device-based scenario also works for the new user (device seeded).
  const t2 = await startCase(newUser, 'my windows laptop is really slow and low on storage');
  check('device scenario works for pilot user (device ensured)', t2.case.state === 'waiting_for_approval' && t2.case.scenario === 'device_slow_storage');

  // 2) Entra session contract hides the demo switcher (authMode=entra, no identities).
  const savedMode = process.env.WATSON_AUTH_MODE;
  const savedRole = process.env.WATSON_ADMIN_APP_ROLE;
  try {
    process.env.WATSON_AUTH_MODE = 'entra';
    process.env.WATSON_ADMIN_APP_ROLE = 'Watson.Admin';
    const req = new Request('http://localhost/api/it-agent/session', {
      headers: { 'x-ms-client-principal': principal([{ typ: 'preferred_username', val: 'admin@hrelectriccompany.com' }, { typ: 'roles', val: 'Watson.Admin' }]) }
    });
    const res = await sessionGET(req);
    const body = await res.json();
    check('session GET reports authMode=entra', body.data?.authMode === 'entra');
    check('entra session exposes NO demo identities (switcher hidden)', Array.isArray(body.data?.identities) && body.data.identities.length === 0);
    check('entra session resolves the admin actor from the verified principal', body.data?.actor?.role === 'admin');
    // demo header must NOT elevate in entra mode
    const demoReq = new Request('http://localhost/api/it-agent/session', { headers: { 'x-watson-role': 'owner' } });
    const demoRes = await sessionGET(demoReq);
    const demoBody = await demoRes.json();
    check('entra mode ignores x-watson-role (no elevation)', demoBody.data?.actor?.role !== 'owner');
  } finally {
    if (savedMode === undefined) delete process.env.WATSON_AUTH_MODE; else process.env.WATSON_AUTH_MODE = savedMode;
    if (savedRole === undefined) delete process.env.WATSON_ADMIN_APP_ROLE; else process.env.WATSON_ADMIN_APP_ROLE = savedRole;
  }

  return { pass, fail, failures };
}
