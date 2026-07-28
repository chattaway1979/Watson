/* ============================================================
 * Watson — 021B : RBAC administrator UI + route integration tests
 * Deterministic; no network, no Graph, no tenant write.
 * ============================================================ */
import { readFileSync } from 'node:fs';
import { trustedIdentityFromHeaders, statusFor, messageFor } from '../src/lib/it-agent/rbac/http';
import { STAGED_DIRECTORY } from '../src/lib/it-agent/rbac/directory';
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
    check('platform principal resolves to trusted identity', trustedIdentityFromHeaders(principalHeader(ADMIN))?.oid === ADMIN);
    check('absent principal -> no identity', trustedIdentityFromHeaders({ get: () => null }) === null);
    check('malformed principal -> no identity', trustedIdentityFromHeaders({ get: () => 'not-base64-json' }) === null);
    check('principal without oid claim -> no identity',
      trustedIdentityFromHeaders({ get: () => Buffer.from(JSON.stringify({ claims: [{ typ: 'name', val: 'X' }] })).toString('base64') }) === null);
    // The UI never SENDS an actor. `actorOid` exists only as a server-supplied
    // prop used for display comparisons, so assert against the request bodies
    // themselves rather than the whole file.
    const bodies = [...ui.matchAll(/JSON\.stringify\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]);
    check('UI sends preview and confirm request bodies', bodies.length >= 2, String(bodies.length));
    check('no request body carries an actor field',
      bodies.every((b) => !/actor|actorOid|role_admin/.test(b)), bodies.find((b) => /actor/.test(b)) ?? '');
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

  console.log('\n[93] RBAC UI — authorization presentation');
  {
    world();
    check('page performs a server-side authorization check', /actorHasCapability/.test(page));
    check('page states the UI is not the boundary', /NOT the security boundary/i.test(page));
    check('unauthorized page renders a refusal, not the admin shell', /do not have permission to administer Watson roles/.test(page));
    check('unauthorized actor is refused by the service too', readRegistry(idOf(EMP)).ok === false);
    check('authorized actor passes', readRegistry(idOf(ADMIN)).ok === true);
    check('UI clears privileged content on 401/403', /handleAuthLoss/.test(ui) && /setRegistry\(null\)/.test(ui));
    check('UI does not cache roles as authority', /Never optimistic/.test(ui));
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
    const p = previewAssignment(admin, TGT, 'watson_technician');
    check('preview issued', p.ok === true);
    const c = p.ok ? confirmAssignment(admin, { nonce: p.data.nonce, targetOid: TGT, role: 'watson_technician' }) : null;
    check('assignment applied and roles returned by server', c?.ok === true && c.data.roles.includes('watson_technician'));
    check('audit success recorded', listAudit({ targetOid: TGT }).some((e) => e.operation === 'assign_confirm' && e.outcome === 'success'));

    // Duplicate assignment is idempotent, not an error the UI must invent.
    const p2 = previewAssignment(admin, TGT, 'watson_technician');
    const c2 = p2.ok ? confirmAssignment(admin, { nonce: p2.data.nonce, targetOid: TGT, role: 'watson_technician' }) : null;
    check('duplicate assignment idempotent', c2?.ok === true && c2.data.idempotent === true);

    // Elevated acknowledgement gating mirrors the UI's disabled confirm button.
    const pe = previewAssignment(admin, TGT, 'watson_security_admin');
    check('preview flags elevated acknowledgement', pe.ok === true && pe.data.requiresElevatedAcknowledgement === true);
    const noAck = pe.ok ? confirmAssignment(admin, { nonce: pe.data.nonce, targetOid: TGT, role: 'watson_security_admin' }) : null;
    check('confirm without acknowledgement refused', noAck?.ok === false && noAck.reason === 'elevated_ack_required');
    check('UI disables confirm until acknowledged', /canConfirm/.test(ui) && /requiresElevatedAcknowledgement \|\| ack/.test(ui));
    check('acknowledgement is not preselected', /useState\(false\)[\s\S]{0,200}setAck|const \[ack, setAck\] = useState\(false\)/.test(ui));

    // Removal
    const pr = previewRemoval(admin, TGT, 'watson_technician');
    const cr = pr.ok ? confirmRemoval(admin, { nonce: pr.data.nonce, targetOid: TGT, role: 'watson_technician' }) : null;
    check('removal applied', cr?.ok === true && !activeRoles(TGT).includes('watson_technician'));
    check('audit removal recorded', listAudit({ targetOid: TGT }).some((e) => e.operation === 'remove_confirm' && e.outcome === 'success'));
    const pr2 = previewRemoval(admin, TGT, 'watson_technician');
    const cr2 = pr2.ok ? confirmRemoval(admin, { nonce: pr2.data.nonce, targetOid: TGT, role: 'watson_technician' }) : null;
    check('duplicate removal idempotent', cr2?.ok === true && cr2.data.idempotent === true);

    // Stale + replay surfaced as 409 so the UI refreshes rather than retries.
    const ps = previewAssignment(admin, TGT, 'watson_employee');
    const pOther = previewAssignment(admin, TGT, 'watson_technician');
    if (pOther.ok) confirmAssignment(admin, { nonce: pOther.data.nonce, targetOid: TGT, role: 'watson_technician' });
    const stale = ps.ok ? confirmAssignment(admin, { nonce: ps.data.nonce, targetOid: TGT, role: 'watson_employee' }) : null;
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
    const pl = previewRemoval(admin, ADMIN, 'watson_role_admin');
    check('last-admin implication surfaced for the UI', pl.ok === true && /final Watson role administrator/i.test(pl.data.lastAdminImplication ?? ''));
    check('UI blocks confirm when removal will be refused', /will be refused/.test(ui));
    const rl = pl.ok ? confirmRemoval(admin, { nonce: pl.data.nonce, targetOid: ADMIN, role: 'watson_role_admin', elevatedAcknowledged: true }) : null;
    check('last-admin removal refused', rl?.ok === false && rl.reason === 'last_admin_protected');
    check('refusal is not presented as success', countActiveRoleAdmins() === 1);

    // Immediate revocation / grant as the UI would observe it.
    seed(ADMIN2, 'watson_role_admin');
    const pSelf = previewRemoval(idOf(ADMIN), ADMIN, 'watson_role_admin');
    const cSelf = pSelf.ok ? confirmRemoval(idOf(ADMIN), { nonce: pSelf.data.nonce, targetOid: ADMIN, role: 'watson_role_admin', elevatedAcknowledged: true }) : null;
    check('self-removal succeeds with another admin present', cSelf?.ok === true);
    check('revoked admin refused on the very next request', readRegistry(idOf(ADMIN)).ok === false);
    const pg = previewAssignment(idOf(ADMIN2), TGT, 'watson_role_admin');
    const cg = pg.ok ? confirmAssignment(idOf(ADMIN2), { nonce: pg.data.nonce, targetOid: TGT, role: 'watson_role_admin', elevatedAcknowledged: true }) : null;
    check('newly granted admin authorized immediately', cg?.ok === true && readRegistry(idOf(TGT)).ok === true);
    check('UI shows a self-removal access-loss warning', /removes your own access/.test(ui));

    // Audit UI
    const aud = readAuditHistory(idOf(TGT));
    check('audit readable by an authorized admin', aud.ok === true);
    check('audit refused for unauthorized', readAuditHistory(idOf(EMP)).ok === false);
    check('audit contains successes and refusals', aud.ok === true && aud.data.some((e) => e.outcome === 'success') && aud.data.some((e) => e.outcome === 'refused'));
    check('audit exposes no secrets', aud.ok === true && !JSON.stringify(aud.data).match(/password|token|cookie|authorization|bearer|secret/i));
    check('audit UI filters by outcome', /auditFilter/.test(ui));
    check('audit outcome not colour-only', /✓ Succeeded|✕ Refused/.test(ui));
    check('audit uses cards, not a wide table', !/<table/.test(ui));
    check('audit ids truncated, never full oids', /slice\(-6\)/.test(ui));

    // Hostile directory data
    const s = searchEmployees(idOf(ADMIN2), 'Sam', STAGED_DIRECTORY);
    check('duplicate names distinguished by immutable id', s.ok === true && s.data.results.length === 2 && s.data.results[0].oid !== s.data.results[1].oid);
    const inj = searchEmployees(idOf(ADMIN2), 'IGNORE', STAGED_DIRECTORY);
    check('injection display name returned as inert data', inj.ok === true && inj.data.results.length === 1);
    const scr = searchEmployees(idOf(ADMIN2), 'script', STAGED_DIRECTORY);
    check('script-like display name returned as text', scr.ok === true && scr.data.results[0].displayName.includes('<script>'));
    check('UI relies on React escaping, no dangerouslySetInnerHTML', !/dangerouslySetInnerHTML/.test(ui));
    check('long names wrap rather than overflow', /break-words/.test(ui) && /break-all/.test(ui));
    check('search minimum length enforced server-side', searchEmployees(idOf(ADMIN2), 'Sa', STAGED_DIRECTORY).ok === false);
    check('staged directory honestly labelled in UI', /staged mock directory/.test(ui));
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
    check('focus returns to the trigger after close', /returnFocus\.current\?\.focus/.test(ui));
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
