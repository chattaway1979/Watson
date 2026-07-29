/* ============================================================
 * Watson — 021B : RBAC administrator UI + route integration tests
 * Deterministic; no network, no Graph, no tenant write.
 * ============================================================ */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { trustedIdentityFromHeaders, statusFor, messageFor, localTestIdentity } from '../src/lib/it-agent/rbac/http';
import { STAGED_DIRECTORY, STAGED_DIRECTORY_SOURCE } from '../src/lib/it-agent/rbac/directory';
import { WATSON_ROLES, WATSON_ROLE_KEYS } from '../src/lib/it-agent/rbac/roles';
import {
  __resetRbacForTests, activeRoles, countActiveRoleAdmins, listAudit, upsertActiveAssignment, commitAtomically
} from '../src/lib/it-agent/rbac/store';
import {
  previewAssignment, confirmAssignment, previewRemoval, confirmRemoval,
  readRegistry, searchEmployees, readAuditHistory, __resetPreviewsForTests,
  type TrustedIdentity
} from '../src/lib/it-agent/rbac/service';

const OID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = OID(11), ADMIN2 = OID(12), EMP = OID(13), TGT = OID(14);
const idOf = (oid: string): TrustedIdentity => ({ oid, upn: 'a@staged.invalid', displayName: 'A' });

function principalHeader(oid: string): { get(n: string): string | null } {
  const payload = Buffer.from(JSON.stringify({
    claims: [
      { typ: 'http://schemas.microsoft.com/identity/claims/objectidentifier', val: oid },
      { typ: 'preferred_username', val: 'a@staged.invalid' },
      { typ: 'name', val: 'A' }
    ]
  })).toString('base64');
  return { get: (n: string) => (n.toLowerCase() === 'x-ms-client-principal' ? payload : null) };
}
function seed(oid: string, role: Parameters<typeof upsertActiveAssignment>[0]['role']) {
  commitAtomically(
    () => upsertActiveAssignment({ targetOid: oid, targetDisplayName: null, targetUpn: null, role, source: 'migration', actorOid: 'system:test' }),
    { correlationId: 'seed', actorOid: 'system:test', actorUpn: null, targetOid: oid, operation: 'seed', outcome: 'success', reason: 'seed', previousRoles: [], resultingRoles: [role], source: 'migration', elevatedAcknowledged: null }
  );
}
function world() { __resetRbacForTests(); __resetPreviewsForTests(); seed(ADMIN, 'watson_role_admin'); seed(EMP, 'watson_employee'); }

export async function runRbacUiTests(): Promise<{ pass: number; fail: number; failures: string[] }> {
  let pass = 0, fail = 0; const failures: string[] = [];
  const check = (n: string, c: boolean, d = '') => {
    if (c) { pass++; console.log('  ✅ ' + n); }
    else { fail++; failures.push(n + (d ? ` — ${d}` : '')); console.log('  ❌ ' + n + (d ? ` — ${d}` : '')); }
  };
  const ui = readFileSync('src/components/it-agent/rbac/AccessAndRoles.tsx', 'utf8');
  const page = readFileSync('src/app/admin/access-and-roles/page.tsx', 'utf8');

  console.log('\n[92] RBAC UI — identity boundary and routes');
  {
    // An explicit env is passed so these assertions describe the code, not the
    // shell the suite happens to run in. An operator with WATSON_LOCAL_TEST_OID
    // exported for browser validation must not change what these prove.
    const NO_SEAM = {} as NodeJS.ProcessEnv;
    check('platform principal resolves to trusted identity', trustedIdentityFromHeaders(principalHeader(ADMIN), NO_SEAM)?.oid === ADMIN);
    check('absent principal -> no identity', trustedIdentityFromHeaders({ get: () => null }, NO_SEAM) === null);
    check('malformed principal -> no identity', trustedIdentityFromHeaders({ get: () => 'not-base64-json' }, NO_SEAM) === null);
    check('principal without oid claim -> no identity',
      trustedIdentityFromHeaders({ get: () => Buffer.from(JSON.stringify({ claims: [{ typ: 'name', val: 'X' }] })).toString('base64') }, NO_SEAM) === null);
    // The UI never SENDS an actor. `actorOid` exists only as a server-supplied
    // prop used for display comparisons, so assert against the request bodies
    // themselves rather than the whole file.
    const bodies = [...ui.matchAll(/JSON\.stringify\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]);
    check('UI sends preview and confirm request bodies', bodies.length >= 2, String(bodies.length));
    check('no request body carries an actor field',
      bodies.every((b) => !/\bactor|\bactorOid|\brole_admin\b/.test(b)), bodies.find((b) => /actor/.test(b)) ?? '');
    check('request bodies carry only target, role, nonce and acknowledgement',
      bodies.every((b) => /targetOid|nonce|role|displayName|elevatedAcknowledged/.test(b)));
    check('routes note that the body never supplies the actor',
      readFileSync('src/app/api/it-agent/rbac/assign/confirm/route.ts', 'utf8').includes('never supplies the actor'));
    for (const p of ['registry', 'search', 'employee', 'audit', 'assign/preview', 'assign/confirm', 'remove/preview', 'remove/confirm']) {
      check(`route exists: ${p}`, readFileSync(`src/app/api/it-agent/rbac/${p}/route.ts`, 'utf8').includes('trustedIdentityFromHeaders'));
    }
    check('no generic mutation route exists',
      !/rbac\/(mutate|role|set)\b/.test(ui) && !/generic/i.test(ui));
    check('401 mapped for unauthenticated', statusFor('unauthenticated') === 401);
    check('403 mapped for last-admin protection', statusFor('last_admin_protected') === 403);
    check('409 mapped for stale preview', statusFor('stale_preview') === 409);
    check('500 mapped for persistence failure', statusFor('persistence_failure') === 500);
    check('errors expose no stack or SQL', ['unauthenticated', 'stale_preview', 'persistence_failure', 'audit_failure'].every((r) => {
      const m = messageFor(r as never); return !/stack|sql|exception|at Object|undefined/i.test(m.message + m.nextAction);
    }));
    check('every refusal carries a next action', ['unauthenticated', 'not_authorized', 'last_admin_protected', 'stale_preview', 'replayed_preview', 'elevated_ack_required'].every((r) => messageFor(r as never).nextAction.length > 8));
  }

  console.log('\n[98] RBAC — local test seam is inert in production (021C)');
  {
    const OK = '00000000-0000-4000-8000-000000000099';
    // The seam must be OFF unless explicitly configured, and OFF in production
    // no matter what is configured.
    check('seam off with no configuration', localTestIdentity({} as NodeJS.ProcessEnv) === null);
    check('seam OFF in production even when configured',
      localTestIdentity({ NODE_ENV: 'production', WATSON_LOCAL_TEST_OID: OK } as unknown as NodeJS.ProcessEnv) === null);
    check('seam on in development when explicitly configured',
      localTestIdentity({ NODE_ENV: 'development', WATSON_LOCAL_TEST_OID: OK } as unknown as NodeJS.ProcessEnv)?.oid === OK);
    check('seam still requires a well-formed object id',
      localTestIdentity({ NODE_ENV: 'development', WATSON_LOCAL_TEST_OID: 'watson_role_admin' } as unknown as NodeJS.ProcessEnv) === null);
    check('seam cannot be triggered by an email address',
      localTestIdentity({ NODE_ENV: 'development', WATSON_LOCAL_TEST_OID: 'c.hattaway@hrelectriccompany.com' } as unknown as NodeJS.ProcessEnv) === null);
    check('platform principal is used when the seam is not configured',
      trustedIdentityFromHeaders(principalHeader(ADMIN), {} as NodeJS.ProcessEnv)?.oid === ADMIN);
    // 021C-1A: on a developer machine nothing sits in front of the app to strip
    // `x-ms-client-principal`, so a browser CAN send one. When the seam is
    // configured it must therefore win — the local actor is chosen by server
    // configuration, never by a request header.
    check('browser-supplied principal cannot override the configured local seam',
      trustedIdentityFromHeaders(principalHeader(ADMIN),
        { NODE_ENV: 'development', WATSON_LOCAL_TEST_OID: OK } as unknown as NodeJS.ProcessEnv)?.oid === OK);
    check('in production the platform principal still wins over any seam configuration',
      trustedIdentityFromHeaders(principalHeader(ADMIN),
        { NODE_ENV: 'production', WATSON_LOCAL_TEST_OID: OK } as unknown as NodeJS.ProcessEnv)?.oid === ADMIN);
    const httpSrc = readFileSync('src/lib/it-agent/rbac/http.ts', 'utf8');
    check('seam reads configuration only, never a request value',
      /WATSON_LOCAL_TEST_OID/.test(httpSrc) && !/x-watson-role|searchParams/i.test(httpSrc));
    check('seam documented as production-inert', /ignored entirely when NODE_ENV/.test(httpSrc));
  }

  console.log('\n[93] RBAC UI — authorization presentation');
  {
    world();
    // 021C-1A: the check moved into the shared entry point so the page and the
    // RBAC routes provably run the same sequence. It is still server-side and
    // still runs before anything renders.
    check('page performs a server-side authorization check', /authorizeRbacEntry\(/.test(page));
    check('the shared entry point is what performs the capability check',
      /actorHasCapability\(actor, capability\)/.test(readFileSync('src/lib/it-agent/rbac/entry.ts', 'utf8')));
    check('page states the UI is not the boundary', /NOT the security boundary/i.test(page));
    check('unauthorized page renders a refusal, not the admin shell', /do not have permission to administer Watson roles/.test(page));
    check('unauthorized actor is refused by the service too', (await readRegistry(idOf(EMP))).ok === false);
    check('authorized actor passes', (await readRegistry(idOf(ADMIN))).ok === true);
    check('UI clears privileged content on 401/403', /handleAuthLoss/.test(ui) && /setRegistry\(null\)/.test(ui));
    check('UI does not cache roles as authority', /Never optimistic/.test(ui));
  }

  // ------------------------------------------------------------
  // 021C-1B — defects found by driving the real UI in a genuine Chrome
  // device-mode session, and fixed. Each check pins one of them so the
  // behaviour cannot silently regress.
  // ------------------------------------------------------------
  console.log('\n[93b] RBAC UI — dialog keyboard ownership and focus restoration (021C-1B)');
  {
    // DEFECT 1: the aria-modal dialog had no Escape handler at all.
    check('Escape is handled while the dialog is open',
      /e\.key === 'Escape'/.test(ui) && /addEventListener\('keydown'/.test(ui));
    check('Escape cancels rather than commits',
      /if \(e\.key === 'Escape'\)[\s\S]{0,240}closePreview\(\)/.test(ui)
      && !/if \(e\.key === 'Escape'\)[\s\S]{0,240}confirm\(\)/.test(ui));
    check('the keydown listener is removed when the dialog closes',
      /removeEventListener\('keydown'/.test(ui));

    // DEFECT 2: Tab walked straight out of an aria-modal dialog.
    check('focus is trapped inside the modal', /e\.key !== 'Tab'/.test(ui) && /Focus trap/.test(ui));
    check('the trap wraps in both directions',
      /e\.shiftKey && \(active === first/.test(ui) && /!e\.shiftKey && active === last/.test(ui));
    check('focus is pulled back if it escapes the dialog',
      /!node\.contains\(active\)[\s\S]{0,60}first\.focus\(\)/.test(ui));

    // DEFECT 3: the trigger element was stored and focused after unmount, so
    // focus silently fell to <body>.
    check('focus target is a stable key, not a detached element reference',
      /returnFocusKey/.test(ui) && !/returnFocus\.current\?\.focus/.test(ui));
    check('assign and remove controls carry a stable trigger key',
      /data-rbac-trigger=\{`assign:\$\{r\.key\}`\}/.test(ui) && /data-rbac-trigger=\{`remove:\$\{k\}`\}/.test(ui));
    check('focus restoration falls back to the sibling control for the same role',
      /\[data-rbac-trigger\$=":\$\{role\}"\]/.test(ui));
    check('focus restoration runs after the re-render, not during the handler',
      /pendingRestore/.test(ui));
    check('section headings are programmatically focusable so a view change never drops focus',
      /ref=\{detailHeadingRef\} tabIndex=\{-1\}/.test(ui) && /ref=\{landingHeadingRef\} tabIndex=\{-1\}/.test(ui));

    // DEFECT 4: the acknowledgement was described by the dialog title, and the
    // only explanation for a disabled confirm was a `title` attribute.
    check('the blocking reason is real text with an id', /id="rbac-ack-hint"/.test(ui));
    check('confirm references the blocking reason', /aria-describedby=\{!canConfirm \? 'rbac-ack-hint'/.test(ui));
    check('the acknowledgement checkbox is described by the reason, not the dialog title',
      /aria-describedby="rbac-ack-hint"/.test(ui) && !/aria-describedby="rbac-dlg"/.test(ui));
    check('the last-admin block explains itself distinctly from the acknowledgement prompt',
      /Watson requires at least one role administrator/.test(ui));
    check('Escape is discoverable, not a hidden affordance', /Press Escape to cancel/.test(ui));

    // DEFECT 5: text-style navigation controls were 20px high — below the 24px
    // WCAG 2.5.8 minimum and impractical to tap at 375px.
    const linkButtons = [...ui.matchAll(/className="([^"]*\bunderline\b[^"]*)"/g)].map((m) => m[1]);
    check('every text-style navigation control has a real touch target',
      linkButtons.length >= 3 && linkButtons.every((cn) => /min-h-11/.test(cn)),
      `${linkButtons.length} found: ${linkButtons.filter((cn) => !/min-h-11/.test(cn)).join(' | ')}`);
  }

  console.log('\n[94] RBAC UI — registry-driven rendering and reserved roles');
  {
    check('UI renders roles from the server registry', /registry\?\.\[k\]|roleList/.test(ui));
    check('UI hardcodes no role description', WATSON_ROLE_KEYS.every((k) => !ui.includes(WATSON_ROLES[k].description)));
    check('Watson-only disclaimer present verbatim',
      /do not grant Microsoft 365, Entra, Azure, Exchange or Defender administrator permissions/.test(ui));
    check('reserved provisioning wording present', /does not currently create accounts, mailboxes, licences or groups/.test(ui));
    check('reserved security wording present', /does not currently purge messages, block domains or modify Defender/.test(ui));
    check('reserved roles labelled in the catalogue', /Reserved — not active/.test(ui));
    check('risk rendered from registry', /\{r\.risk\}/.test(ui));
  }

  console.log('\n[95] RBAC UI — assignment/removal integration');
  {
    world();
    const admin = idOf(ADMIN);
    // Assign through preview+confirm exactly as the UI does.
    const p = (await previewAssignment(admin, TGT, 'watson_technician'));
    check('preview issued', p.ok === true);
    const c = p.ok ? (await confirmAssignment(admin, { nonce: p.data.nonce, targetOid: TGT, role: 'watson_technician' })) : null;
    check('assignment applied and roles returned by server', c?.ok === true && c.data.roles.includes('watson_technician'));
    check('audit success recorded', listAudit({ targetOid: TGT }).some((e) => e.operation === 'assign_confirm' && e.outcome === 'success'));

    // Duplicate assignment is idempotent, not an error the UI must invent.
    const p2 = (await previewAssignment(admin, TGT, 'watson_technician'));
    const c2 = p2.ok ? (await confirmAssignment(admin, { nonce: p2.data.nonce, targetOid: TGT, role: 'watson_technician' })) : null;
    check('duplicate assignment idempotent', c2?.ok === true && c2.data.idempotent === true);

    // Elevated acknowledgement gating mirrors the UI's disabled confirm button.
    const pe = (await previewAssignment(admin, TGT, 'watson_security_admin'));
    check('preview flags elevated acknowledgement', pe.ok === true && pe.data.requiresElevatedAcknowledgement === true);
    const noAck = pe.ok ? (await confirmAssignment(admin, { nonce: pe.data.nonce, targetOid: TGT, role: 'watson_security_admin' })) : null;
    check('confirm without acknowledgement refused', noAck?.ok === false && noAck.reason === 'elevated_ack_required');
    check('UI disables confirm until acknowledged', /canConfirm/.test(ui) && /requiresElevatedAcknowledgement \|\| ack/.test(ui));
    check('acknowledgement is not preselected', /useState\(false\)[\s\S]{0,200}setAck|const \[ack, setAck\] = useState\(false\)/.test(ui));

    // Removal
    const pr = (await previewRemoval(admin, TGT, 'watson_technician'));
    const cr = pr.ok ? (await confirmRemoval(admin, { nonce: pr.data.nonce, targetOid: TGT, role: 'watson_technician' })) : null;
    check('removal applied', cr?.ok === true && !activeRoles(TGT).includes('watson_technician'));
    check('audit removal recorded', listAudit({ targetOid: TGT }).some((e) => e.operation === 'remove_confirm' && e.outcome === 'success'));
    const pr2 = (await previewRemoval(admin, TGT, 'watson_technician'));
    const cr2 = pr2.ok ? (await confirmRemoval(admin, { nonce: pr2.data.nonce, targetOid: TGT, role: 'watson_technician' })) : null;
    check('duplicate removal idempotent', cr2?.ok === true && cr2.data.idempotent === true);

    // Stale + replay surfaced as 409 so the UI refreshes rather than retries.
    const ps = (await previewAssignment(admin, TGT, 'watson_employee'));
    const pOther = (await previewAssignment(admin, TGT, 'watson_technician'));
    if (pOther.ok) (await confirmAssignment(admin, { nonce: pOther.data.nonce, targetOid: TGT, role: 'watson_technician' }));
    const stale = ps.ok ? (await confirmAssignment(admin, { nonce: ps.data.nonce, targetOid: TGT, role: 'watson_employee' })) : null;
    check('stale preview refused', stale?.ok === false && stale.reason === 'stale_preview');
    check('stale maps to 409 so the UI refreshes', statusFor('stale_preview') === 409);
    check('UI drops a stale preview and refreshes', /r\.status === 409[\s\S]{0,160}refreshRoles/.test(ui));
    check('UI guards double submit', /inFlight/.test(ui));
    check('UI does not auto-retry a confirmation', !/retry|setTimeout\([^)]*confirm/i.test(ui));
  }

  console.log('\n[96] RBAC UI — last-admin, revocation, audit, hostile data');
  {
    world();
    const admin = idOf(ADMIN);
    const pl = (await previewRemoval(admin, ADMIN, 'watson_role_admin'));
    check('last-admin implication surfaced for the UI', pl.ok === true && /final Watson role administrator/i.test(pl.data.lastAdminImplication ?? ''));
    check('UI blocks confirm when removal will be refused', /will be refused/.test(ui));
    const rl = pl.ok ? (await confirmRemoval(admin, { nonce: pl.data.nonce, targetOid: ADMIN, role: 'watson_role_admin', elevatedAcknowledged: true })) : null;
    check('last-admin removal refused', rl?.ok === false && rl.reason === 'last_admin_protected');
    check('refusal is not presented as success', countActiveRoleAdmins() === 1);

    // Immediate revocation / grant as the UI would observe it.
    seed(ADMIN2, 'watson_role_admin');
    const pSelf = (await previewRemoval(idOf(ADMIN), ADMIN, 'watson_role_admin'));
    const cSelf = pSelf.ok ? (await confirmRemoval(idOf(ADMIN), { nonce: pSelf.data.nonce, targetOid: ADMIN, role: 'watson_role_admin', elevatedAcknowledged: true })) : null;
    check('self-removal succeeds with another admin present', cSelf?.ok === true);
    check('revoked admin refused on the very next request', (await readRegistry(idOf(ADMIN))).ok === false);
    const pg = (await previewAssignment(idOf(ADMIN2), TGT, 'watson_role_admin'));
    const cg = pg.ok ? (await confirmAssignment(idOf(ADMIN2), { nonce: pg.data.nonce, targetOid: TGT, role: 'watson_role_admin', elevatedAcknowledged: true })) : null;
    check('newly granted admin authorized immediately', cg?.ok === true && (await readRegistry(idOf(TGT))).ok === true);
    check('UI shows a self-removal access-loss warning', /removes your own access/.test(ui));

    // Audit UI
    const aud = (await readAuditHistory(idOf(TGT)));
    check('audit readable by an authorized admin', aud.ok === true);
    check('audit refused for unauthorized', (await readAuditHistory(idOf(EMP))).ok === false);
    check('audit contains successes and refusals', aud.ok === true && aud.data.some((e) => e.outcome === 'success') && aud.data.some((e) => e.outcome === 'refused'));
    check('audit exposes no secrets', aud.ok === true && !JSON.stringify(aud.data).match(/password|token|cookie|authorization|bearer|secret/i));
    check('audit UI filters by outcome', /auditFilter/.test(ui));
    check('audit outcome not colour-only', /✓ Succeeded|✕ Refused/.test(ui));
    check('audit uses cards, not a wide table', !/<table/.test(ui));
    check('audit ids truncated, never full oids', /slice\(-6\)/.test(ui));

    // Hostile directory data
    const s = (await searchEmployees(idOf(ADMIN2), 'Sam', STAGED_DIRECTORY));
    check('duplicate names distinguished by immutable id', s.ok === true && s.data.results.length === 2 && s.data.results[0].oid !== s.data.results[1].oid);
    const inj = (await searchEmployees(idOf(ADMIN2), 'IGNORE', STAGED_DIRECTORY));
    check('injection display name returned as inert data', inj.ok === true && inj.data.results.length === 1);
    const scr = (await searchEmployees(idOf(ADMIN2), 'script', STAGED_DIRECTORY));
    check('script-like display name returned as text', scr.ok === true && scr.data.results[0].displayName.includes('<script>'));
    check('UI relies on React escaping, no dangerouslySetInnerHTML', !/dangerouslySetInnerHTML/.test(ui));
    check('long names wrap rather than overflow', /break-words/.test(ui) && /break-all/.test(ui));
    check('search minimum length enforced server-side', (await searchEmployees(idOf(ADMIN2), 'Sa', STAGED_DIRECTORY)).ok === false);
    check('staged directory honestly labelled in UI', /staged mock directory/.test(ui));
  }

  // ------------------------------------------------------------
  // 021C-2 — staging findings. Both of these shipped in 07b6ff6 and were caught
  // while deploying to Azure. Each check fails against the pre-fix code.
  // ------------------------------------------------------------
  console.log('\n[110] RBAC — directory provenance is never inferred from the environment flag (021C-2)');
  {
    world();
    const LIVE = { IT_AGENT_GRAPH_LIVE_READONLY: 'true' } as unknown as NodeJS.ProcessEnv;
    const OFF = { IT_AGENT_GRAPH_LIVE_READONLY: 'false' } as unknown as NodeJS.ProcessEnv;

    // THE DEFECT: with the gate on, mock fixtures were reported as `graph_live`.
    const withFlag = (await searchEmployees(idOf(ADMIN), 'Sam', STAGED_DIRECTORY_SOURCE, LIVE));
    check('mock fixtures are NOT relabelled graph_live when the gate is on',
      withFlag.ok === true && withFlag.data.source === 'mock_staged_directory',
      withFlag.ok ? withFlag.data.source : 'refused');
    check('the live-read gate state is still reported honestly',
      withFlag.ok === true && withFlag.data.liveReadsEnabled === true);
    check('a provenance mismatch is surfaced, not hidden',
      withFlag.ok === true && withFlag.data.provenanceMismatch === true);
    check('no mismatch is reported when the gate is off',
      await (async () => { const r = (await searchEmployees(idOf(ADMIN), 'Sam', STAGED_DIRECTORY_SOURCE, OFF));
               return r.ok === true && r.data.provenanceMismatch === false && r.data.source === 'mock_staged_directory'; })());

    // A bare array carries no provenance claim, so it can only be staged data.
    const bare = (await searchEmployees(idOf(ADMIN), 'Sam', STAGED_DIRECTORY, LIVE));
    check('a directory without declared provenance can never claim graph_live',
      bare.ok === true && bare.data.source === 'mock_staged_directory');

    // Only a directory that declares itself live may be reported as live.
    const declaredLive = (await searchEmployees(idOf(ADMIN), 'Sam',
      { provenance: 'graph_live' as const, entries: STAGED_DIRECTORY }, LIVE));
    check('only a self-declared live directory is reported as graph_live',
      declaredLive.ok === true && declaredLive.data.source === 'graph_live');

    check('the staged directory declares itself as mock',
      STAGED_DIRECTORY_SOURCE.provenance === 'mock_staged_directory');
    const svc = readFileSync('src/lib/it-agent/rbac/service.ts', 'utf8');
    check('source is no longer derived from the environment flag',
      !/source:\s*liveReadsEnabled\s*\?/.test(svc));
    const searchRoute = readFileSync('src/app/api/it-agent/rbac/search/route.ts', 'utf8');
    check('the search route passes a provenance-bearing directory',
      /STAGED_DIRECTORY_SOURCE/.test(searchRoute));
  }

  console.log('\n[111] RBAC — deployment artifact must not bundle a local runtime store (021C-2)');
  {
    // THE DEFECT: Next's file tracing copied data/watson-store.json into
    // .next/standalone, so the artifact shipped synthetic role assignments.
    const gate = readFileSync('scripts/check-no-bundled-store.mjs', 'utf8');
    check('a package gate script exists', /PACKAGE GATE FAILED/.test(gate));
    check('the gate fails the build rather than warning', /process\.exit\(1\)/.test(gate));
    check('the gate looks for the runtime store by name', /watson-store\.json/.test(gate));
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    check('the gate runs as part of npm run build',
      /check-no-bundled-store/.test(pkg.scripts.build), pkg.scripts.build);
    check('the gate is separately invocable', typeof pkg.scripts['verify:package'] === 'string');
    const nextCfg = readFileSync('next.config.mjs', 'utf8');
    check('file tracing excludes the runtime store directory at the root cause',
      /outputFileTracingExcludes/.test(nextCfg) && /\.\/data\/\*\*/.test(nextCfg));

    // Behavioural: plant a store in a fake standalone tree and prove the gate trips.
    const tmp = mkdtempSync(join(tmpdir(), 'wpkg-'));
    let trippedOnStore = false, passedWhenClean = false;
    try {
      mkdirSync(join(tmp, '.next', 'standalone', 'data'), { recursive: true });
      writeFileSync(join(tmp, '.next', 'standalone', 'data', 'watson-store.json'), '{"rbacAssignments":[]}');
      copyFileSync('scripts/check-no-bundled-store.mjs', join(tmp, 'check.mjs'));
      try {
        execSync('node check.mjs', { cwd: tmp, stdio: 'pipe' });
      } catch { trippedOnStore = true; }
      rmSync(join(tmp, '.next', 'standalone', 'data'), { recursive: true, force: true });
      try { execSync('node check.mjs', { cwd: tmp, stdio: 'pipe' }); passedWhenClean = true; } catch { passedWhenClean = false; }
    } finally {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    check('the gate FAILS when a runtime store is bundled', trippedOnStore);
    check('the gate PASSES on a clean artifact', passedWhenClean);
  }

  console.log('\n[97] RBAC UI — responsive and accessibility source probes');
  {
    check('no fixed pixel widths', !/w-\[\d+px\]/.test(ui));
    check('flex rows wrap at narrow widths', /flex-wrap/.test(ui));
    check('shrinkable text uses min-w-0', /min-w-0/.test(ui));
    check('no horizontal-scroll table dependency', !/overflow-x-auto/.test(ui));
    check('search input has a label', /htmlFor="rbac-q"/.test(ui) && /id="rbac-q"/.test(ui));
    check('assign/remove buttons have accessible names', /aria-label=\{`Assign /.test(ui) && /aria-label=\{`Remove /.test(ui));
    check('dialog has role, modal and label', /role="dialog"/.test(ui) && /aria-modal="true"/.test(ui) && /aria-labelledby="rbac-dlg"/.test(ui));
    check('dialog receives focus on open', /dialogRef\.current\?\.focus\(\)/.test(ui));
    // 021C-1B: the stored-element mechanism this used to pin was the defect —
    // the trigger is unmounted by the view swap, so `.focus()` hit a detached
    // node and focus fell to <body>. Pin the mechanism that actually works.
    check('focus returns to the trigger after close',
      /returnFocusKey/.test(ui) && /data-rbac-trigger="\$\{key\}"|\[data-rbac-trigger="\$\{key\}"\]/.test(ui) && /restoreFocus\(\)/.test(ui));
    check('live region announces status', /aria-live="polite"/.test(ui));
    check('errors use role=alert', /role="alert"/.test(ui));
    check('warnings use role=note', /role="note"/.test(ui));
    check('semantic headings present', /<h1/.test(ui) && /<h2/.test(ui) && /<h3/.test(ui));
    check('no positive tabindex', !/tabIndex=\{[1-9]/.test(ui));
    check('focus indicators on interactive controls', (ui.match(/focus-visible:outline/g) ?? []).length >= 10);
    check('status not colour-only (glyph + word)', /✓ /.test(ui) && /⚠ /.test(ui));
    check('destructive removal distinct beyond colour', /✕ Remove/.test(ui));
    check('disabled confirm explains why', /title=\{!canConfirm/.test(ui));
    check('filter buttons expose pressed state', /aria-pressed=\{auditFilter/.test(ui));
  }

  return { pass, fail, failures };
}
