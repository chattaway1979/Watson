/* ============================================================
 * Watson — 021E : employee directory eligibility policy + safe DTO.
 * Deterministic; NO network, NO Graph call, NO real credential.
 * All identity shapes are SYNTHETIC reconstructions of the tenant's observed
 * *patterns* — no real object ids, tokens or live Graph payloads are stored.
 * ============================================================ */
import { readFileSync } from 'node:fs';
import {
  evaluateEligibility, loadDirectoryPolicy, DEFAULT_DIRECTORY_POLICY, DirectoryPolicyError,
  type DirectoryCandidate, type DirectoryEligibilityPolicy
} from '../src/lib/it-agent/rbac/directory-policy';
import { mapGraphUsers, GRAPH_USER_FIELDS, buildUserSearchPath } from '../src/lib/it-agent/rbac/graph-directory';

const OID = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;
const ALLOWED = OID(901), DENIED = OID(902);

// A synthetic candidate with sensible defaults; each test overrides what matters.
const cand = (over: Partial<DirectoryCandidate> = {}): DirectoryCandidate => ({
  oid: OID(1), displayName: 'Test Person', userPrincipalName: 'test.person@hrelectriccompany.com',
  mail: null, userType: 'Member', accountEnabled: true,
  employeeId: null, employeeType: null, department: 'Field', jobTitle: 'Superintendent', ...over
});
const reason = (over: Partial<DirectoryCandidate> = {}, p?: DirectoryEligibilityPolicy) =>
  evaluateEligibility(cand(over), p ?? DEFAULT_DIRECTORY_POLICY).eligibilityReasonCode;
const selectable = (over: Partial<DirectoryCandidate> = {}, p?: DirectoryEligibilityPolicy) =>
  evaluateEligibility(cand(over), p ?? DEFAULT_DIRECTORY_POLICY).selectionAllowed;

export async function runRbacDirectoryPolicyTests(): Promise<{ pass: number; fail: number; failures: string[] }> {
  let pass = 0, fail = 0; const failures: string[] = [];
  const check = (n: string, c: boolean, d = '') => {
    if (c) { pass++; console.log('  ✅ ' + n); }
    else { fail++; failures.push(n + (d ? ` — ${d}` : '')); console.log('  ❌ ' + n + (d ? ` — ${d}` : '')); }
  };

  console.log('\n[116] RBAC directory policy — eligibility decisions (021E)');
  {
    check('an enabled Member on an approved domain with a role signal is eligible',
      reason() === 'eligible_employee' && selectable() === true, reason());
    check('jobTitle alone is a sufficient positive signal',
      reason({ department: null, jobTitle: 'Foreman' }) === 'eligible_employee');
    check('department alone is a sufficient positive signal',
      reason({ department: 'Estimating', jobTitle: null }) === 'eligible_employee');
    check('employeeId alone is a sufficient positive signal',
      reason({ department: null, jobTitle: null, employeeId: 'E-1042' }) === 'eligible_employee');
    check('employeeType alone is a sufficient positive signal',
      reason({ department: null, jobTitle: null, employeeType: 'Employee' }) === 'eligible_employee');

    // The whole reason a domain-only filter was rejected.
    check('an approved-domain Member with NO signal is ambiguous, not eligible',
      reason({ department: null, jobTitle: null }) === 'ambiguous_member');
    check('an ambiguous member is NOT selectable',
      selectable({ department: null, jobTitle: null }) === false);

    check('a disabled account is reported disabled',
      reason({ accountEnabled: false }) === 'disabled_account');
    check('a disabled account is NOT selectable', selectable({ accountEnabled: false }) === false);
    check('a disabled account beats every other classification',
      reason({ accountEnabled: false, userPrincipalName: 'svc.thing@hrelectriccompany.com' }) === 'disabled_account');
    check('accountEnabled null is ambiguous, never eligible',
      reason({ accountEnabled: null }) === 'ambiguous_member' && selectable({ accountEnabled: null }) === false);
    check('accountEnabled absent is ambiguous, never eligible',
      (() => { const c = cand(); delete (c as { accountEnabled?: unknown }).accountEnabled;
               const d = evaluateEligibility(c as DirectoryCandidate);
               return d.eligibilityReasonCode === 'ambiguous_member' && d.selectionAllowed === false; })());

    check('a Guest is reported as a guest account', reason({ userType: 'Guest' }) === 'guest_account');
    check('a Guest is NOT selectable', selectable({ userType: 'Guest' }) === false);
    check('an unknown userType is treated as external', reason({ userType: 'Other' }) === 'guest_account');
    // The observed tenant reports Member for everything, so userType must not be
    // the only gate — this pins that the rest of the policy still applies.
    check('userType=Member alone does not make an identity eligible',
      reason({ userType: 'Member', userPrincipalName: 'breakglass@hrelectriccompany.com', department: null, jobTitle: null })
        === 'excluded_bootstrap_identity');
  }

  console.log('\n[117] RBAC directory policy — exclusions observed in the real tenant (021E)');
  {
    // Break-glass ON the corporate domain: the case that defeats a domain filter.
    check('break-glass on the APPROVED domain is excluded as bootstrap',
      reason({ userPrincipalName: 'breakglass@hrelectriccompany.com', displayName: 'Emergency Break-Glass', department: null, jobTitle: null })
        === 'excluded_bootstrap_identity');
    check('break-glass is excluded even when it carries a department and title',
      reason({ userPrincipalName: 'breakglass@NETORGFT1615407.onmicrosoft.com', displayName: 'Emergency Access', department: 'Emergency', jobTitle: 'Break Glass Account' })
        === 'excluded_bootstrap_identity');
    check('the tenant default domain is bootstrap, not cross-tenant',
      reason({ userPrincipalName: 'info@NETORGFT1615407.onmicrosoft.com', department: null, jobTitle: null })
        === 'excluded_bootstrap_identity');
    check('a different tenant domain is cross-tenant',
      reason({ userPrincipalName: 'c.hattaway@lumensync.io', department: null, jobTitle: null })
        === 'excluded_cross_tenant_identity');
    check('a cross-tenant identity is not selectable',
      selectable({ userPrincipalName: 'someone@lumensync.io' }) === false);
    check('a shared mailbox on the approved domain is excluded as shared',
      reason({ userPrincipalName: 'info@hrelectriccompany.com', displayName: 'H&R Electric General Inbox', department: null, jobTitle: null })
        === 'excluded_shared_mailbox');
    check('a second shared mailbox pattern is excluded',
      reason({ userPrincipalName: 'estimating@hrelectriccompany.com', displayName: 'H&R Electric Estimating Inbox', department: null, jobTitle: null })
        === 'excluded_shared_mailbox');
    check('a service identity is excluded as a service identity',
      reason({ userPrincipalName: 'svc.backup@hrelectriccompany.com', department: null, jobTitle: null })
        === 'excluded_service_identity');
    check('an automation display name is excluded',
      reason({ userPrincipalName: 'thing@hrelectriccompany.com', displayName: 'MDM Push Certificate', department: null, jobTitle: null })
        === 'excluded_service_identity');
    check('an exclusion applies even when a positive signal is present',
      reason({ userPrincipalName: 'info@hrelectriccompany.com', displayName: 'General Inbox', department: 'Admin', jobTitle: 'Mailbox' })
        !== 'eligible_employee');
    check('every real-employee shape from the tenant survey stays eligible',
      ['Brad.H', 'c.hattaway', 'carrie', 'jessika', 'joshua', 'jt.munoz', 'preston', 'r.chavez']
        .every((l) => reason({ userPrincipalName: `${l}@hrelectriccompany.com` }) === 'eligible_employee'));
  }

  console.log('\n[118] RBAC directory policy — configuration, allow/deny and fail-closed (021E)');
  {
    const withIds: DirectoryEligibilityPolicy = {
      ...DEFAULT_DIRECTORY_POLICY,
      explicitlyAllowedObjectIds: [ALLOWED], explicitlyExcludedObjectIds: [DENIED]
    };
    check('an explicitly allowed object id overrides domain and signal rules',
      reason({ oid: ALLOWED, userPrincipalName: 'contractor@lumensync.io', department: null, jobTitle: null }, withIds) === 'explicitly_allowed');
    check('an explicitly allowed identity is selectable',
      selectable({ oid: ALLOWED, userPrincipalName: 'contractor@lumensync.io' }, withIds) === true);
    check('an explicitly excluded object id overrides eligibility',
      reason({ oid: DENIED }, withIds) === 'explicitly_excluded');
    check('an explicitly excluded identity is not selectable', selectable({ oid: DENIED }, withIds) === false);
    check('a disabled account is still disabled even when explicitly allowed',
      reason({ oid: ALLOWED, accountEnabled: false }, withIds) === 'disabled_account');
    check('allow/deny match is case-insensitive on the object id',
      reason({ oid: DENIED.toUpperCase() }, withIds) === 'explicitly_excluded');

    const hide: DirectoryEligibilityPolicy = { ...DEFAULT_DIRECTORY_POLICY, ambiguousMemberHandling: 'hide' };
    check('ambiguous handling "hide" marks the row hidden',
      evaluateEligibility(cand({ department: null, jobTitle: null }), hide).hidden === true);
    check('ambiguous handling "warn" keeps the row visible but unselectable',
      (() => { const d = evaluateEligibility(cand({ department: null, jobTitle: null }), DEFAULT_DIRECTORY_POLICY);
               return d.hidden === false && d.selectionAllowed === false; })());

    // Configuration parsing — malformed input must FAIL CLOSED.
    const bad: Array<[string, string]> = [
      ['not JSON', '{nope'],
      ['a JSON array', '[]'],
      ['a bad ambiguous mode', '{"ambiguousMemberHandling":"maybe"}'],
      ['a non-string domain list', '{"approvedEmployeeDomains":[1,2]}'],
      ['an empty domain list', '{"approvedEmployeeDomains":[]}'],
      ['a non-guid allow id', '{"explicitlyAllowedObjectIds":["not-a-guid"]}'],
      ['a non-guid deny id', '{"explicitlyExcludedObjectIds":["nope"]}'],
      ['an invalid regex', '{"excludedAddressPatterns":["([unclosed"]}']
    ];
    for (const [label, raw] of bad) {
      let threw = false;
      try { loadDirectoryPolicy({ WATSON_DIRECTORY_POLICY: raw } as unknown as NodeJS.ProcessEnv); }
      catch (e) { threw = e instanceof DirectoryPolicyError; }
      check(`malformed policy rejected: ${label}`, threw);
    }
    check('absent configuration uses the safe defaults',
      loadDirectoryPolicy({} as NodeJS.ProcessEnv).approvedEmployeeDomains.includes('hrelectriccompany.com'));
    check('a valid override is honoured',
      loadDirectoryPolicy({ WATSON_DIRECTORY_POLICY: '{"approvedEmployeeDomains":["example.com"]}' } as unknown as NodeJS.ProcessEnv)
        .approvedEmployeeDomains.join(',') === 'example.com');
  }

  console.log('\n[119] RBAC directory policy — safe DTO mapping (021E)');
  {
    const gu = (over: Record<string, unknown>) => ({
      id: OID(1), displayName: 'Test Person', userPrincipalName: 'test.person@hrelectriccompany.com',
      mail: 'test.person@hrelectriccompany.com', userType: 'Member', accountEnabled: true,
      department: 'Field', jobTitle: 'Superintendent', ...over
    });
    check('Graph field selection requests exactly the policy inputs',
      GRAPH_USER_FIELDS.join(',') === 'id,displayName,userPrincipalName,mail,userType,accountEnabled,employeeId,employeeType,department,jobTitle',
      GRAPH_USER_FIELDS.join(','));
    check('the request path selects those fields',
      decodeURIComponent(buildUserSearchPath('test')).includes('$select=' + GRAPH_USER_FIELDS.join(',')));

    const rows = mapGraphUsers({ value: [gu({})] });
    check('a mapped row carries the eligibility decision',
      rows?.[0].eligibilityReasonCode === 'eligible_employee' && rows?.[0].selectionAllowed === true);
    check('the immutable object id is the durable key', rows?.[0].oid === OID(1));

    // Decision inputs must NOT be echoed to the browser.
    const blob = JSON.stringify(rows);
    for (const leak of ['department', 'jobTitle', 'employeeId', 'employeeType', 'Field', 'Superintendent']) {
      check(`DTO does not leak "${leak}"`, !blob.includes(leak), blob.slice(0, 100));
    }
    check('DTO exposes only the agreed keys',
      Object.keys(rows?.[0] ?? {}).sort().join(',') ===
        'accountEnabled,displayName,eligibilityReasonCode,employeeEligibility,mail,oid,selectionAllowed,upn,userType',
      Object.keys(rows?.[0] ?? {}).sort().join(','));
    check('no raw Graph object survives mapping',
      !blob.includes('@odata') && !blob.includes('businessPhones') && !blob.includes('officeLocation'));

    const disabled = mapGraphUsers({ value: [gu({ accountEnabled: false })] });
    check('a disabled account is RETURNED (not silently dropped) and marked',
      disabled?.length === 1 && disabled[0].eligibilityReasonCode === 'disabled_account' && disabled[0].selectionAllowed === false);
    const hidden = mapGraphUsers({ value: [gu({ department: null, jobTitle: null })] },
      { ...DEFAULT_DIRECTORY_POLICY, ambiguousMemberHandling: 'hide' });
    check('a hidden ambiguous row is omitted from results', hidden?.length === 0);

    check('rows without a valid object id are dropped',
      mapGraphUsers({ value: [gu({ id: 'not-a-guid' })] })?.length === 0);
    check('null and malformed fields do not crash mapping',
      mapGraphUsers({ value: [gu({ displayName: null, mail: null, userType: null, department: 5, jobTitle: {} })] })?.length === 1);
    check('malformed body is still distinguishable from empty',
      mapGraphUsers({ notValue: 1 }) === null && mapGraphUsers({ value: [] })?.length === 0);
    check('the 25-result cap still holds',
      mapGraphUsers({ value: Array.from({ length: 60 }, (_, i) => gu({ id: OID(100 + i) })) })?.length === 25);

    // Duplicate display names must stay distinguishable by immutable id.
    const dupes = mapGraphUsers({ value: [
      gu({ id: OID(11), displayName: 'Clint Hattaway', userPrincipalName: 'c.hattaway@hrelectriccompany.com' }),
      gu({ id: OID(12), displayName: 'Clint Hattaway', userPrincipalName: 'c.h2@hrelectriccompany.com' })
    ] });
    check('duplicate display names remain distinguishable',
      dupes?.length === 2 && dupes[0].oid !== dupes[1].oid && dupes[0].upn !== dupes[1].upn);

    // --- UI presentation of the policy decision ---
    const uiSrc = readFileSync('src/components/it-agent/rbac/AccessAndRoles.tsx', 'utf8');
    check('the UI has a label for every reason code the policy can emit',
      ['eligible_employee','explicitly_allowed','disabled_account','guest_account',
       'excluded_service_identity','excluded_shared_mailbox','excluded_bootstrap_identity',
       'excluded_cross_tenant_identity','ambiguous_member','explicitly_excluded']
        .every((c) => uiSrc.includes(c + ':')), 'missing a reason-code label');
    check('the UI defaults to NOT selectable when the server did not say',
      /selectionAllowed !== false/.test(uiSrc));
    check('non-selectable rows are not rendered as buttons',
      /aria-disabled="true"/.test(uiSrc) && /Not selectable\./.test(uiSrc));
    check('status is conveyed by glyph and word, not colour alone',
      /'✓ '/.test(uiSrc) || /✓ /.test(uiSrc));
    check('an unconfirmed identity is never described as an employee',
      /Watson cannot confirm this is an employee account/.test(uiSrc));
    check('a disabled account explains it cannot sign in',
      /disabled and cannot sign in/.test(uiSrc));
    check('an administrative identity is called out explicitly',
      /emergency-access identity/.test(uiSrc));
    check('the UI keys selection on the immutable object id, never a name',
      /targetOid: selected\.oid/.test(uiSrc) || /selected\.oid/.test(uiSrc));
    check('the UI never keys a grant on displayName, mail or upn',
      !/targetOid:\s*\w+\.(displayName|upn|mail)/.test(uiSrc));
  }

  console.log('\n[120] Staging deployment guard — the 021D failure modes (021E)');
  {
    const g = readFileSync('scripts/deploy-staging.mjs', 'utf8');
    const order = [
      'verify clean intended source', 'install dependencies',
      'run tests and static validation', 'build from the current source',
      'verify the build corresponds to the current source', 'package the verified build',
      'verify package contents and absence of runtime state', 'deploy the package',
      'restart to remount the package', 'poll until the worker serves the expected SHA',
      'verify deployed posture'
    ];
    const idx = order.map((o) => g.indexOf(o));
    check('every mandated step exists in the guard', idx.every((i) => i > 0),
      order.filter((o, i) => idx[i] < 0).join(', '));
    check('the steps appear in the mandated order',
      idx.every((v, i) => i === 0 || v > idx[i - 1]));
    check('build happens BEFORE packaging', g.indexOf('npm run build') < g.indexOf('package the verified build'));
    // Match the executable invocation, not the phrase in the header comment.
    check('packaging happens BEFORE deploying',
      g.indexOf('package the verified build') < g.indexOf('az webapp deploy --resource-group'));

    // The two 021D failure modes.
    check('a stale .next is removed before building', /rmSync\(path\.join\(process\.cwd\(\), '\.next'\)/.test(g));
    check('the guard rejects source newer than the build output',
      /source newer than build output \(stale build\)/.test(g));
    check('the guard restarts to remount run-from-package', /az webapp restart/.test(g));
    check('the guard distinguishes accepted from active',
      /deploymentAccepted/.test(g) && /deploymentActive/.test(g));
    check('the guard fails on a served-SHA mismatch',
      /served \$\{?.*\}? != package|servedSha|shaMatch/.test(g) && /never converged/.test(g));

    // Other mandated guarantees.
    check('the guard refuses a dirty working tree', /uncommitted changes/.test(g));
    check('the guard refuses the wrong branch', /refusing to deploy from branch/.test(g));
    check('the guard rejects a bundled runtime store', /runtime store bundled/.test(g));
    check('the guard refuses if live execution is enabled', /live execution is enabled/.test(g));
    check('the guard verifies Easy Auth still rejects anonymous access',
      /anonymous access to the admin page returned/.test(g));
    check('the guard stops on the first failure', /if \(failed\) \{ steps\.push/.test(g));
    check('the guard emits a machine-readable verdict',
      /JSON\.stringify\(result/.test(g) && /process\.exit\(failed \? 1 : 0\)/.test(g));
    check('the guard never prints app settings wholesale',
      /stdio: 'ignore'/.test(g) && !/appsettings list/.test(g));
    check('the guard targets only the isolated staging app',
      /watson-pilot-hrnp01/.test(g) && !/watson-staged-015/.test(g) && !/lumensync/i.test(g));
  }

  return { pass, fail, failures };
}
