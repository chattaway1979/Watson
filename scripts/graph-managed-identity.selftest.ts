/* ============================================================
 * Watson — WATSON-MANAGED-IDENTITY-GRAPH-READINESS-011B
 * Managed-identity Graph credential + actor/target isolation self-tests.
 *
 * NO network, NO Azure SDK, NO Graph call. Token providers are injected fakes
 * and the "tokens" are locally constructed JWT-shaped strings that carry only a
 * `roles` claim. The real ManagedIdentityCredential is never constructed.
 * ============================================================ */
import {
  evaluateGraphCredential,
  validateGraphRolePosture,
  extractGraphRoles,
  graphClientSecretPosture,
  graphManagedIdentityReadiness,
  createManagedIdentityGraphHttpClient,
  failClosedGraphTokenProvider,
  REQUIRED_GRAPH_APP_ROLES,
  type GraphTokenProvider
} from '../src/lib/it-agent/graph/graph-managed-identity';
import {
  resolveEmployeeDiagnosticSubject,
  caseSubjectAligned,
  graphSubjectOrNull,
  scopeDecisionForAudit,
  normalizeDirectoryIdentity
} from '../src/lib/it-agent/graph/graph-actor-scope';
import { bootstrapM365ReadOnlyConnector, __resetGraphLiveFactoriesForTests } from '../src/lib/it-agent/graph/graph-bootstrap';
import { isLiveExternalExecutionEnabled, operatingMode } from '../src/lib/it-agent/constants';
import type { Actor } from '../src/lib/it-agent/types';

// A JWT-shaped token carrying only a roles claim. Distinctive so we can prove
// it never appears in any serialized output.
const TOKEN_MARKER = 'MI-GRAPH-TOKEN-MUST-NEVER-APPEAR';
function fakeToken(roles: string[]): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ roles, marker: TOKEN_MARKER })).toString('base64url');
  return `${header}.${payload}.${TOKEN_MARKER}`;
}
const providerWith = (roles: string[]): GraphTokenProvider => ({
  id: 'azure-managed-identity',
  async getToken() { return fakeToken(roles); }
});
const providerFailing: GraphTokenProvider = {
  id: 'azure-managed-identity',
  async getToken() { return null; }
};

const MI_ENV = {
  IT_AGENT_GRAPH_LIVE_READONLY: 'false',
  IT_AGENT_LIVE_EXTERNAL_EXECUTION: 'false'
} as unknown as NodeJS.ProcessEnv;
const withEnv = (o: Record<string, string>) =>
  ({ ...MI_ENV, ...o }) as unknown as NodeJS.ProcessEnv;

const employee = (email?: string): Actor =>
  ({ id: 'u1', type: 'user', role: 'employee', email });
const admin = (email: string): Actor =>
  ({ id: 'a1', type: 'admin', role: 'admin', email });

export async function runGraphManagedIdentityTests(): Promise<{ pass: number; fail: number; failures: string[] }> {
  let pass = 0;
  let fail = 0;
  const failures: string[] = [];
  const check = (name: string, cond: boolean, detail = '') => {
    if (cond) { pass++; console.log('  ✅ ' + name); }
    else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log('  ❌ ' + name + (detail ? ` — ${detail}` : '')); }
  };

  console.log('\n[53] Managed-identity Graph credential (011B)');

  // --- 1. MI configured + gate false => mock / inactive -------------------
  {
    const ev = await evaluateGraphCredential({ env: MI_ENV, tokenProvider: providerWith([...REQUIRED_GRAPH_APP_ROLES]), probe: true });
    check('gate false => live_gate_disabled', ev.state === 'live_gate_disabled', ev.state);
    check('gate false => liveReadWouldAttempt false', ev.liveReadWouldAttempt === false);
    check('gate false => no token acquired (no posture computed)', ev.posture === undefined);
    const r = await bootstrapM365ReadOnlyConnector({ env: MI_ENV });
    check('gate false => connector resolves to mock', r.mode === 'mock', r.mode);
  }

  // --- 9. Missing managed identity fails closed --------------------------
  {
    const ev = await evaluateGraphCredential({
      env: withEnv({ IT_AGENT_GRAPH_LIVE_READONLY: 'true' }),
      tokenProvider: failClosedGraphTokenProvider, probe: true
    });
    check('missing managed identity => managed_identity_unavailable', ev.state === 'managed_identity_unavailable', ev.state);
    check('missing managed identity => not live', ev.liveReadWouldAttempt === false);
  }

  // --- token acquisition failure is distinct from absent identity --------
  {
    const ev = await evaluateGraphCredential({
      env: withEnv({ IT_AGENT_GRAPH_LIVE_READONLY: 'true' }), tokenProvider: providerFailing, probe: true
    });
    check('identity present but token fails => token_unavailable', ev.state === 'token_unavailable', ev.state);
  }

  // --- gate on without an explicit probe must not claim readiness --------
  {
    const ev = await evaluateGraphCredential({ env: withEnv({ IT_AGENT_GRAPH_LIVE_READONLY: 'true' }) });
    check('gate on without probe never claims readiness', ev.state === 'managed_identity_unavailable' && !ev.liveReadWouldAttempt);
  }

  // --- 10. Missing required Graph role fails closed -----------------------
  {
    const ev = await evaluateGraphCredential({
      env: withEnv({ IT_AGENT_GRAPH_LIVE_READONLY: 'true' }),
      tokenProvider: providerWith(['User.Read.All']), probe: true
    });
    check('missing required role => graph_permission_incomplete', ev.state === 'graph_permission_incomplete', ev.state);
    check('missing required role => not live', ev.liveReadWouldAttempt === false);
    check('missing roles are itemised', (ev.posture?.missing ?? []).includes('MailboxSettings.Read'));
  }

  // --- 11 & 12. Forbidden permissions fail posture validation -------------
  {
    const write = validateGraphRolePosture([...REQUIRED_GRAPH_APP_ROLES, 'User.ReadWrite.All']);
    check('write permission fails posture validation', write.ok === false && write.forbidden.includes('User.ReadWrite.All'));

    const dir = validateGraphRolePosture([...REQUIRED_GRAPH_APP_ROLES, 'Directory.Read.All']);
    check('Directory.Read.All fails posture validation', dir.ok === false && dir.forbidden.includes('Directory.Read.All'));

    const role = validateGraphRolePosture([...REQUIRED_GRAPH_APP_ROLES, 'RoleManagement.ReadWrite.Directory']);
    check('RoleManagement fails posture validation', role.ok === false);

    const dev = validateGraphRolePosture([...REQUIRED_GRAPH_APP_ROLES, 'DeviceManagementManagedDevices.Read.All']);
    check('DeviceManagement fails posture validation', dev.ok === false);

    const ok = validateGraphRolePosture([...REQUIRED_GRAPH_APP_ROLES]);
    check('approved minimum set passes posture validation', ok.ok === true && ok.missing.length === 0 && ok.forbidden.length === 0);

    check('GroupMember.Read.All is NOT in the required set',
      !(REQUIRED_GRAPH_APP_ROLES as readonly string[]).includes('GroupMember.Read.All'));
    const gm = validateGraphRolePosture([...REQUIRED_GRAPH_APP_ROLES, 'GroupMember.Read.All']);
    check('GroupMember.Read.All is reported as unexpected (not forbidden)',
      gm.unexpected.includes('GroupMember.Read.All') && !gm.forbidden.includes('GroupMember.Read.All'));
  }

  // --- 8. No client-secret fallback exists --------------------------------
  {
    check('no secret in env => posture ok', graphClientSecretPosture(MI_ENV).ok === true);
    const bad = graphClientSecretPosture(withEnv({ AZURE_CLIENT_SECRET: 'x' }));
    check('AZURE_CLIENT_SECRET present => posture FAILS', bad.ok === false && bad.offendingKeys.includes('AZURE_CLIENT_SECRET'));
    const bad2 = graphClientSecretPosture(withEnv({ GRAPH_CLIENT_SECRET: 'x' }));
    check('GRAPH_CLIENT_SECRET present => posture FAILS', bad2.ok === false);

    // The transport must have no secret path at all: with no token it throws
    // rather than reaching for any other credential.
    const http = createManagedIdentityGraphHttpClient(
      { tenantId: 't', clientId: 'c', clientSecretRef: '', keyVaultUrl: '', graphBaseUrl: 'https://graph.microsoft.com/v1.0', liveReadOnlyEnabled: true },
      failClosedGraphTokenProvider
    );
    let threw = false;
    try { await http.getToken(); } catch { threw = true; }
    check('transport throws when MI token unavailable (no fallback)', threw === true);
  }

  // --- 13. Key Vault absence does not block MI readiness ------------------
  {
    const noKv = withEnv({ IT_AGENT_GRAPH_LIVE_READONLY: 'true' });
    delete (noKv as Record<string, unknown>).AZURE_KEY_VAULT_URL;
    const ev = await evaluateGraphCredential({ env: noKv, tokenProvider: providerWith([...REQUIRED_GRAPH_APP_ROLES]), probe: true });
    check('no Key Vault configured => credential still ready', ev.state === 'credential_ready', ev.state);
    check('readiness declares Key Vault not required for Graph',
      graphManagedIdentityReadiness(noKv).keyVaultRequiredForGraph === false);
  }

  // --- 6 & 7. Token never escapes ----------------------------------------
  {
    const env = withEnv({ IT_AGENT_GRAPH_LIVE_READONLY: 'true' });
    const ev = await evaluateGraphCredential({ env, tokenProvider: providerWith([...REQUIRED_GRAPH_APP_ROLES]), probe: true });
    check('credential ready with approved roles', ev.state === 'credential_ready', ev.state);
    check('evaluation output contains no token', !JSON.stringify(ev).includes(TOKEN_MARKER));
    check('readiness output contains no token', !JSON.stringify(graphManagedIdentityReadiness(env)).includes(TOKEN_MARKER));
    check('audit projection contains no token',
      !JSON.stringify(scopeDecisionForAudit({ allowed: false, reason: 'cross_user_target' })).includes(TOKEN_MARKER));
    // Role extraction must yield ONLY role strings — no other claim escapes.
    const roles = extractGraphRoles(fakeToken(['User.Read.All']));
    check('extractGraphRoles returns only roles (no other claims)',
      roles.length === 1 && roles[0] === 'User.Read.All');
    check('malformed token yields no roles (fail closed)', extractGraphRoles('not-a-jwt').length === 0);
    check('null token yields no roles', extractGraphRoles(null).length === 0);
  }

  // --- 2. MI configured does not enable external execution ----------------
  {
    const priorExec = process.env.IT_AGENT_LIVE_EXTERNAL_EXECUTION;
    const priorRead = process.env.IT_AGENT_GRAPH_LIVE_READONLY;
    const priorMode = process.env.IT_AGENT_MODE;
    try {
      process.env.IT_AGENT_LIVE_EXTERNAL_EXECUTION = 'false';
      process.env.IT_AGENT_GRAPH_LIVE_READONLY = 'true';
      check('managed identity + Graph gate on does NOT enable external execution',
        isLiveExternalExecutionEnabled() === false);
      // --- 14. MOCK label required while execution gate is false ----------
      process.env.IT_AGENT_MODE = 'live';
      check('MOCK operating mode retained even if IT_AGENT_MODE=live', operatingMode() === 'mock');
    } finally {
      if (priorExec === undefined) delete process.env.IT_AGENT_LIVE_EXTERNAL_EXECUTION; else process.env.IT_AGENT_LIVE_EXTERNAL_EXECUTION = priorExec;
      if (priorRead === undefined) delete process.env.IT_AGENT_GRAPH_LIVE_READONLY; else process.env.IT_AGENT_GRAPH_LIVE_READONLY = priorRead;
      if (priorMode === undefined) delete process.env.IT_AGENT_MODE; else process.env.IT_AGENT_MODE = priorMode;
    }
  }

  // --- Production bootstrap now uses managed identity, not a secret -------
  // No legacy seam is injected here, so this is exactly the path the deployed
  // route takes.
  {
    // Earlier suites override the module-level Azure factories to exercise the
    // legacy path; clear that so this block runs the real production path.
    __resetGraphLiveFactoriesForTests();
    const liveEnv = withEnv({ IT_AGENT_GRAPH_LIVE_READONLY: 'true' });

    const ready = await bootstrapM365ReadOnlyConnector({
      env: liveEnv, tokenProvider: providerWith([...REQUIRED_GRAPH_APP_ROLES])
    });
    check('bootstrap (no injection) assembles live connector from managed identity',
      ready.mode === 'live_readonly', ready.mode);

    const noMi = await bootstrapM365ReadOnlyConnector({ env: liveEnv, tokenProvider: failClosedGraphTokenProvider });
    check('bootstrap fails closed when managed identity yields no token',
      noMi.mode === 'fail_closed' && noMi.reason === 'managed_identity_unavailable',
      noMi.mode === 'fail_closed' ? noMi.reason : noMi.mode);

    const badRoles = await bootstrapM365ReadOnlyConnector({
      env: liveEnv, tokenProvider: providerWith(['User.Read.All'])
    });
    check('bootstrap fails closed when required Graph roles are missing',
      badRoles.mode === 'fail_closed' && badRoles.reason === 'graph_permission_incomplete',
      badRoles.mode === 'fail_closed' ? badRoles.reason : badRoles.mode);

    const forbidden = await bootstrapM365ReadOnlyConnector({
      env: liveEnv, tokenProvider: providerWith([...REQUIRED_GRAPH_APP_ROLES, 'Directory.Read.All'])
    });
    check('bootstrap fails closed when a forbidden role is present',
      forbidden.mode === 'fail_closed' && forbidden.reason === 'graph_permission_incomplete');

    // No secret is consulted anywhere on this path: with the gate on and a good
    // token, no Key Vault configuration exists at all.
    check('managed-identity bootstrap needs no Key Vault configuration',
      ready.mode === 'live_readonly' && !liveEnv.AZURE_KEY_VAULT_URL);

    // And with the gate off it is still mock, regardless of credential health.
    const off = await bootstrapM365ReadOnlyConnector({
      env: MI_ENV, tokenProvider: providerWith([...REQUIRED_GRAPH_APP_ROLES])
    });
    check('gate off => mock even with a healthy managed identity', off.mode === 'mock', off.mode);
  }

  // ================================================================
  console.log('\n[54] Actor/target isolation before Graph (011B)');

  // --- 3. Browser cannot supply the diagnostic target ---------------------
  {
    const self = resolveEmployeeDiagnosticSubject({ actor: employee('sarah@hrelectriccompany.com') });
    check('subject derived from verified session identity', self.allowed === true && self.subject === 'sarah@hrelectriccompany.com');
    check('subject source is the session, not the request',
      self.allowed === true && self.subjectSource === 'verified_session_identity');

    const supplied = resolveEmployeeDiagnosticSubject({
      actor: employee('sarah@hrelectriccompany.com'), clientSuppliedTarget: 'sarah@hrelectriccompany.com'
    });
    check('client-supplied target refused even when it matches self',
      supplied.allowed === false && supplied.reason === 'client_supplied_target');
  }

  // --- 4. Employee cannot target another employee -------------------------
  {
    const cross = resolveEmployeeDiagnosticSubject({
      actor: employee('sarah@hrelectriccompany.com'), clientSuppliedTarget: 'ceo@hrelectriccompany.com'
    });
    check('employee targeting another employee is refused',
      cross.allowed === false && cross.reason === 'cross_user_target');
    check('refused decision yields no Graph subject (call cannot happen)',
      graphSubjectOrNull(cross) === null);
    check('refusal reason leaks no attempted target',
      !JSON.stringify(scopeDecisionForAudit(cross)).includes('ceo@hrelectriccompany.com'));

    // No existence oracle: a malformed address and a real one are refused
    // identically, so responses cannot distinguish them.
    const malformed = resolveEmployeeDiagnosticSubject({
      actor: employee('sarah@hrelectriccompany.com'), clientSuppliedTarget: 'not-an-email'
    });
    check('malformed and real cross-user targets are indistinguishable',
      malformed.allowed === false && malformed.reason === 'cross_user_target');

    // Graph path injection attempts are refused by the same rule.
    const inject = resolveEmployeeDiagnosticSubject({
      actor: employee('sarah@hrelectriccompany.com'), clientSuppliedTarget: 'x@y.com/../../groups?$select=id'
    });
    check('Graph path/OData injection in target is refused',
      inject.allowed === false && inject.reason === 'cross_user_target');
  }

  // --- 5. Unknown/ambiguous mapping fails closed --------------------------
  {
    check('no authenticated actor fails closed',
      resolveEmployeeDiagnosticSubject({ actor: null }).allowed === false);
    const unmapped = resolveEmployeeDiagnosticSubject({ actor: employee(undefined) });
    check('session without directory identity fails closed',
      unmapped.allowed === false && unmapped.reason === 'identity_unmapped');
    const blank = resolveEmployeeDiagnosticSubject({ actor: employee('   ') });
    check('blank identity fails closed', blank.allowed === false && blank.reason === 'identity_unmapped');
    const junk = resolveEmployeeDiagnosticSubject({ actor: employee('not-an-email') });
    check('unparseable session identity fails closed',
      junk.allowed === false && junk.reason === 'identity_unmapped');
  }

  // --- admin targeting is out of scope on this path -----------------------
  {
    const a = resolveEmployeeDiagnosticSubject({ actor: admin('boss@hrelectriccompany.com') });
    check('admin cross-user targeting is out of scope on the employee path',
      a.allowed === false && a.reason === 'admin_targeting_out_of_scope');
  }

  // --- case ownership alignment ------------------------------------------
  {
    check('case owner matching subject is aligned',
      caseSubjectAligned('sarah@hrelectriccompany.com', 'Sarah@HRElectricCompany.com') === true);
    check('case owner differing from subject is refused',
      caseSubjectAligned('sarah@hrelectriccompany.com', 'ceo@hrelectriccompany.com') === false);
    check('missing case owner fails closed', caseSubjectAligned(null, 'sarah@hrelectriccompany.com') === false);
    check('identity normalization is case-insensitive and trimmed',
      normalizeDirectoryIdentity('  Sarah@HRElectricCompany.com ') === 'sarah@hrelectriccompany.com');
  }

  return { pass, fail, failures };
}
