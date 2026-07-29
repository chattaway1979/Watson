/* ============================================================
 * Watson — 021G : shared RBAC persistence, atomicity and migration.
 * Deterministic; NO network, NO database, NO real identity.
 * Every identity is synthetic. The in-memory adapter is the REFERENCE
 * implementation, so these assertions define the semantics the Postgres
 * adapter must satisfy.
 * ============================================================ */
import { readFileSync } from 'node:fs';
import { MemoryRbacStore } from '../src/lib/it-agent/rbac/memory-adapter';
import { digestNonce, generateNonce, type PreviewRecord } from '../src/lib/it-agent/rbac/persistence';
import { planMigration, applyMigration, checksumOf, MigrationError } from '../src/lib/it-agent/rbac/migrate';
import type { RoleAssignment, RbacAuditEvent } from '../src/lib/it-agent/rbac/store';

const OID = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;
const A = OID(1), B = OID(2), C = OID(3);

const grant = (s: MemoryRbacStore, target: string, role: RoleAssignment['role'], actor = A) =>
  s.grantRole({
    targetOid: target, targetDisplayName: null, targetUpn: null, role,
    source: 'administrator', actorOid: actor, actorUpn: null,
    correlationId: 'c-' + Math.random().toString(36).slice(2, 8),
    elevatedAcknowledged: true, previousRoles: [], resultingRoles: [role]
  });
const revoke = (s: MemoryRbacStore, target: string, role: RoleAssignment['role'], actor = A) =>
  s.revokeRole({
    targetOid: target, role, actorOid: actor, actorUpn: null,
    correlationId: 'c-' + Math.random().toString(36).slice(2, 8),
    elevatedAcknowledged: true, previousRoles: [role], resultingRoles: []
  });

const preview = (over: Partial<PreviewRecord> = {}): PreviewRecord => ({
  digest: 'd-' + Math.random().toString(36).slice(2, 10),
  operation: 'assign', actorOid: A, targetOid: B, role: 'watson_technician',
  stateVersion: 0, expiresAt: new Date(Date.now() + 600_000).toISOString(),
  elevatedRequired: false, payload: '{}', ...over
});

export async function runRbacPersistenceTests(): Promise<{ pass: number; fail: number; failures: string[] }> {
  let pass = 0, fail = 0; const failures: string[] = [];
  const check = (n: string, c: boolean, d = '') => {
    if (c) { pass++; console.log('  ✅ ' + n); }
    else { fail++; failures.push(n + (d ? ` — ${d}` : '')); console.log('  ❌ ' + n + (d ? ` — ${d}` : '')); }
  };

  console.log('\n[121] RBAC shared store — assignments, audit and bootstrap (021G)');
  {
    const s = new MemoryRbacStore();
    check('a fresh store has no administrators', (await s.countActiveRoleAdmins()) === 0);
    check('store reports its kind', s.kind === 'memory');
    check('store answers a liveness probe', (await s.ping()) === true);

    const g = await grant(s, B, 'watson_technician');
    check('grant applies', g.ok === true && g.data.applied === true);
    check('durable read reflects the grant', (await s.activeRoles(B)).join() === 'watson_technician');
    check('grant appended exactly one audit row', s.auditRowCount() === 1);

    const dup = await grant(s, B, 'watson_technician');
    check('re-granting is idempotent, not a second row',
      dup.ok === true && dup.data.applied === false && dup.data.idempotent === true);
    check('assignment uniqueness holds (principal + role)',
      s.allAssignments().filter((x) => x.active && x.targetOid === B && x.role === 'watson_technician').length === 1);

    const r = await revoke(s, B, 'watson_technician');
    check('revoke applies', r.ok === true && r.data.applied === true);
    check('revoked role is gone from the active set', (await s.activeRoles(B)).length === 0);
    check('revocation is a deactivation, not a delete (history preserved)',
      s.allAssignments().some((x) => x.targetOid === B && x.active === false && x.removedAt !== null));
    const dupR = await revoke(s, B, 'watson_technician');
    check('re-revoking is idempotent', dupR.ok === true && dupR.data.idempotent === true);

    // Audit is append-only from the application's view.
    const beforeCount = s.auditRowCount();
    await grant(s, C, 'watson_employee');
    check('audit only ever grows', s.auditRowCount() > beforeCount);
    const rows = await s.listAudit({ limit: 500 });
    check('audit rows carry actor, target, operation, outcome and correlation',
      rows.every((e) => e.actorOid && e.operation && e.outcome && e.correlationId));
    check('audit read is bounded', (await s.listAudit({ limit: 9999 })).length <= 500);

    // Bootstrap idempotency.
    const s2 = new MemoryRbacStore();
    const b1 = await s2.tryBootstrap(A, 'boot-1');
    check('bootstrap creates the first administrator',
      b1.ok === true && b1.data.applied === true && (await s2.countActiveRoleAdmins()) === 1);
    const b2 = await s2.tryBootstrap(A, 'boot-2');
    check('bootstrap is a no-op once an administrator exists',
      b2.ok === true && b2.data.applied === false && b2.data.reason === 'persistent_admin_exists');
    check('repeat bootstrap never creates a second administrator', (await s2.countActiveRoleAdmins()) === 1);
    check('exactly one bootstrap SUCCESS audit row exists',
      (await s2.listAudit({ limit: 500 })).filter((e) => e.operation === 'bootstrap' && e.outcome === 'success').length === 1);
  }

  console.log('\n[122] RBAC shared store — transactional atomicity (021G)');
  {
    // grant + audit must land together, or neither.
    const s = new MemoryRbacStore();
    s.inject = { failAuditWrite: true };
    const g = await grant(s, B, 'watson_technician');
    check('grant is rolled back when the audit write fails', g.ok === false && g.reason === 'audit_failure');
    check('no assignment survives a failed audit', (await s.activeRoles(B)).length === 0);
    check('no orphaned audit row survives', s.auditRowCount() === 0);

    s.inject = { failAssignmentWrite: true };
    const g2 = await grant(s, B, 'watson_technician');
    check('grant fails closed when the assignment write fails',
      g2.ok === false && g2.reason === 'persistence_failure');
    check('no audit row describes a change that did not happen', s.auditRowCount() === 0);

    // revoke + audit atomicity
    s.inject = {};
    await grant(s, B, 'watson_technician');
    const auditAfterGrant = s.auditRowCount();
    s.inject = { failAuditWrite: true };
    const r = await revoke(s, B, 'watson_technician');
    check('revoke is rolled back when the audit write fails', r.ok === false && r.reason === 'audit_failure');
    check('the role is still held after a rolled-back revoke',
      (await s.activeRoles(B)).join() === 'watson_technician');
    check('audit did not grow on a rolled-back revoke', s.auditRowCount() === auditAfterGrant);

    // store unavailable => fail closed, never silent success
    s.inject = { unavailable: true };
    const un = await grant(s, C, 'watson_employee');
    check('a configured-but-unavailable store fails closed',
      un.ok === false && un.reason === 'store_unavailable');
    check('liveness probe reports unavailable', (await s.ping()) === false);
    s.inject = {};
  }

  console.log('\n[123] RBAC shared store — final-administrator protection is transactional (021G)');
  {
    const s = new MemoryRbacStore();
    await s.tryBootstrap(A, 'boot');
    check('one administrator exists', (await s.countActiveRoleAdmins()) === 1);
    const solo = await revoke(s, A, 'watson_role_admin');
    check('removing the only administrator is refused', solo.ok === false && solo.reason === 'last_admin_protected');
    check('the refusal is audited',
      (await s.listAudit({ limit: 500 })).some((e) => e.reason === 'last_admin_protected'));
    check('no mutation occurred', (await s.countActiveRoleAdmins()) === 1);

    // THE RACE: two concurrent removals with two administrators must not reach zero.
    await grant(s, B, 'watson_role_admin');
    check('two administrators exist', (await s.countActiveRoleAdmins()) === 2);
    const [r1, r2] = await Promise.all([
      revoke(s, A, 'watson_role_admin'),
      revoke(s, B, 'watson_role_admin')
    ]);
    const survivors = await s.countActiveRoleAdmins();
    check('two concurrent removals never reach zero administrators', survivors >= 1, `survivors=${survivors}`);
    check('exactly one concurrent removal succeeded',
      [r1, r2].filter((x) => x.ok === true && x.data.applied === true).length === 1,
      JSON.stringify([r1.ok, r2.ok]));
    check('the losing removal was refused by last-admin protection',
      [r1, r2].some((x) => x.ok === false && x.reason === 'last_admin_protected'));

    // Many concurrent removals, same invariant.
    const s2 = new MemoryRbacStore();
    await s2.tryBootstrap(A, 'boot');
    await grant(s2, B, 'watson_role_admin');
    const many = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      revoke(s2, i % 2 === 0 ? A : B, 'watson_role_admin')));
    check('under 8 concurrent removals at least one administrator remains',
      (await s2.countActiveRoleAdmins()) >= 1, String(await s2.countActiveRoleAdmins()));
    check('only one of the 8 concurrent removals applied a change',
      many.filter((x) => x.ok === true && x.data.applied === true).length === 1,
      String(many.filter((x) => x.ok === true && x.data.applied === true).length));
  }

  console.log('\n[124] RBAC shared store — preview nonces (021G)');
  {
    const s = new MemoryRbacStore();
    const raw = await generateNonce();
    const raw2 = await generateNonce();
    check('nonces are unguessable (256-bit CSPRNG, base64url)', raw.length > 40 && raw !== raw2);
    check('nonces are unique across generations', new Set(await Promise.all(
      Array.from({ length: 50 }, () => generateNonce()))).size === 50);

    const d = await digestNonce(raw);
    check('digest is a stable sha256 hex', /^[0-9a-f]{64}$/.test(d));
    check('digest is deterministic', d === (await digestNonce(raw)));
    check('different nonces digest differently', d !== (await digestNonce(raw2)));

    // The RAW nonce must never be persisted.
    await s.putPreview(preview({ digest: d }));
    // Serialise what is ACTUALLY held: a Map stringifies to {}, which would make
    // this assertion pass without proving anything.
    const dump = JSON.stringify(s.dumpPreviewsForTests());
    check('the raw nonce is never stored', !dump.includes(raw), 'raw nonce found in store');
    check('only the digest is stored', dump.includes(d), dump.slice(0, 90));
    check('the stored record carries no field equal to the raw nonce',
      !Object.values(s.dumpPreviewsForTests()[0] ?? {}).some((v) => v === raw));

    const binding = { operation: 'assign' as const, actorOid: A, targetOid: B, role: 'watson_technician' };
    // Binding: actor / target / role / action substitution all rejected.
    check('actor substitution rejected',
      (await s.consumePreview(d, { ...binding, actorOid: C }, Date.now())).ok === false);
    check('actor substitution reason is actor_mismatch',
      (await s.consumePreview(d, { ...binding, actorOid: C }, Date.now()) as { reason: string }).reason === 'actor_mismatch');
    check('target substitution rejected as target_mismatch',
      (await s.consumePreview(d, { ...binding, targetOid: C }, Date.now()) as { reason: string }).reason === 'target_mismatch');
    check('role substitution rejected as role_mismatch',
      (await s.consumePreview(d, { ...binding, role: 'watson_role_admin' }, Date.now()) as { reason: string }).reason === 'role_mismatch');
    check('action substitution (assign nonce used as remove) rejected as stale',
      (await s.consumePreview(d, { ...binding, operation: 'remove' }, Date.now()) as { reason: string }).reason === 'stale_preview');
    check('a failed binding check does NOT consume the nonce',
      (await s.consumePreview(d, binding, Date.now())).ok === true);
    // ...and now it IS consumed.
    check('single use: the second consumption is refused as replay',
      (await s.consumePreview(d, binding, Date.now()) as { reason: string }).reason === 'replayed_preview');

    // Expiry.
    const dExp = await digestNonce(await generateNonce());
    await s.putPreview(preview({ digest: dExp, expiresAt: new Date(Date.now() - 1000).toISOString() }));
    check('an expired nonce is refused as stale',
      (await s.consumePreview(dExp, binding, Date.now()) as { reason: string }).reason === 'stale_preview');

    // Unknown digest is indistinguishable from expired: no existence oracle.
    check('an unknown digest is refused as stale, not "not found"',
      (await s.consumePreview('f'.repeat(64), binding, Date.now()) as { reason: string }).reason === 'stale_preview');

    // Stale state version (TOCTOU).
    const dv = await digestNonce(await generateNonce());
    await s.putPreview(preview({ digest: dv, stateVersion: 99 }));
    check('a nonce whose target state moved is refused as stale',
      (await s.consumePreview(dv, binding, Date.now()) as { reason: string }).reason === 'stale_preview');

    // CONCURRENCY: two simultaneous confirmations, exactly one wins.
    const dc = await digestNonce(await generateNonce());
    await s.putPreview(preview({ digest: dc }));
    const results = await Promise.all(Array.from({ length: 6 }, () => s.consumePreview(dc, binding, Date.now())));
    check('concurrent confirmation of one nonce succeeds exactly once',
      results.filter((r) => r.ok).length === 1, String(results.filter((r) => r.ok).length));
    check('the losers are refused as replay',
      results.filter((r) => !r.ok).every((r) => (r as { reason: string }).reason === 'replayed_preview'));

    // Housekeeping.
    const before = s.previewCount();
    const purged = await s.purgeExpiredPreviews(Date.now());
    check('expired and consumed previews are purged', purged > 0 && s.previewCount() < before);

    // Errors reveal nothing.
    const failedOnly = JSON.stringify(results.filter((r) => !r.ok));
    check('consumption FAILURES reveal no actor, target, role or digest',
      !/00000000-0000-4000|watson_technician|[0-9a-f]{64}/.test(failedOnly), failedOnly.slice(0, 90));
    check('a failure carries only a safe reason code',
      results.filter((r) => !r.ok).every((r) => Object.keys(r).sort().join(',') === 'ok,reason'),
      failedOnly.slice(0, 90));
  }

  console.log('\n[125] RBAC migration — determinism, verification and idempotency (021G)');
  {
    const src = {
      rbacAssignments: [
        { assignmentId: 'a1', targetOid: A, targetDisplayName: null, targetUpn: null, role: 'watson_role_admin',
          active: true, source: 'bootstrap', assignedAt: '2026-07-29T10:00:00.000Z', assignedByOid: 'system:bootstrap',
          modifiedAt: '2026-07-29T10:00:00.000Z', modifiedByOid: 'system:bootstrap', removedAt: null, removedByOid: null, version: 1 },
        { assignmentId: 'a2', targetOid: B, targetDisplayName: null, targetUpn: null, role: 'watson_technician',
          active: false, source: 'administrator', assignedAt: '2026-07-29T10:01:00.000Z', assignedByOid: A,
          modifiedAt: '2026-07-29T10:02:00.000Z', modifiedByOid: A, removedAt: '2026-07-29T10:02:00.000Z', removedByOid: A, version: 2 }
      ],
      rbacAudit: [
        { id: 'e1', at: '2026-07-29T10:00:00.000Z', correlationId: 'c1', actorOid: 'system:bootstrap', actorUpn: null,
          targetOid: A, operation: 'bootstrap', outcome: 'success', reason: 'bootstrap_role_admin_created',
          previousRoles: [], resultingRoles: ['watson_role_admin'], source: 'bootstrap', elevatedAcknowledged: null }
      ]
    };
    const plan = planMigration(src);
    check('plan reports source counts', plan.sourceCounts.assignments === 2 && plan.sourceCounts.audit === 1);
    check('plan identifies the single active administrator', plan.sourceCounts.activeAdmins === 1);
    check('checksum is a sha256 hex', /^[0-9a-f]{64}$/.test(plan.checksum));
    check('planning is deterministic', planMigration(src).checksum === plan.checksum);
    check('checksum is order-independent',
      checksumOf([...plan.assignments].reverse(), plan.audit) === plan.checksum);
    check('checksum changes when a record changes',
      checksumOf(plan.assignments.map((a, i) => i === 0 ? { ...a, role: 'watson_employee' as const } : a), plan.audit) !== plan.checksum);

    const dest = new MemoryRbacStore();
    const rep = await applyMigration(plan, dest);
    check('all assignments migrated', rep.inserted.assignments === 2);
    check('all audit rows migrated', rep.inserted.audit === 1);
    check('destination verification passed', rep.verified === true, JSON.stringify(rep.destinationCounts));
    check('the sole administrator is preserved', (await dest.countActiveRoleAdmins()) === 1);
    check('the administrator is the expected principal',
      (await dest.activeRoles(A)).join() === 'watson_role_admin');
    check('a deactivated row migrated as deactivated', (await dest.activeRoles(B)).length === 0);

    // RERUN must be a no-op.
    const rerun = await applyMigration(plan, dest);
    check('a rerun inserts nothing', rerun.inserted.assignments === 0 && rerun.inserted.audit === 0);
    check('a rerun is reported as idempotent', rerun.idempotentRerun === true);
    check('a rerun does not duplicate assignments', dest.allAssignments().length === 2);
    check('a rerun does not duplicate audit', (await dest.listAudit({ limit: 500 })).length === 1);
    check('the administrator count is unchanged after rerun', (await dest.countActiveRoleAdmins()) === 1);

    // FAIL CLOSED on malformed or contradictory source data.
    const bad: Array<[string, unknown]> = [
      ['assignments not an array', { rbacAssignments: {} }],
      ['audit not an array', { rbacAssignments: [], rbacAudit: 'x' }],
      ['assignment without an id', { rbacAssignments: [{ targetOid: A, role: 'watson_employee', active: true, assignedByOid: A, version: 1 }] }],
      ['duplicate assignment id', { rbacAssignments: [src.rbacAssignments[0], src.rbacAssignments[0]] }],
      ['malformed target oid', { rbacAssignments: [{ ...src.rbacAssignments[0], targetOid: 'nope' }] }],
      ['unknown role', { rbacAssignments: [{ ...src.rbacAssignments[0], role: 'watson_super_admin' }] }],
      ['non-boolean active', { rbacAssignments: [{ ...src.rbacAssignments[0], active: 'yes' }] }],
      ['malformed assignedByOid', { rbacAssignments: [{ ...src.rbacAssignments[0], assignedByOid: 'bob' }] }],
      ['two ACTIVE rows for one principal+role', { rbacAssignments: [src.rbacAssignments[0], { ...src.rbacAssignments[0], assignmentId: 'a9' }] }],
      ['audit without an id', { rbacAssignments: [], rbacAudit: [{ at: '2026-01-01T00:00:00Z', actorOid: A, operation: 'x', outcome: 'success' }] }],
      ['audit with a bad timestamp', { rbacAssignments: [], rbacAudit: [{ ...src.rbacAudit[0], at: 'not-a-date' }] }],
      ['audit with an unknown outcome', { rbacAssignments: [], rbacAudit: [{ ...src.rbacAudit[0], outcome: 'maybe' }] }]
    ];
    let closed = 0;
    for (const [label, s] of bad) {
      try { planMigration(s as never); failures.push('migration accepted bad input: ' + label); fail++; console.log('  ❌ migration should reject: ' + label); }
      catch (e) { if (e instanceof MigrationError) { closed++; } }
    }
    check('every malformed source is rejected fail-closed', closed === bad.length, `${closed}/${bad.length}`);

    // A migration must never be able to produce zero administrators.
    const noAdmin = planMigration({ rbacAssignments: [src.rbacAssignments[1]], rbacAudit: [] });
    check('a source with no administrator is reported honestly, not silently accepted',
      noAdmin.sourceCounts.activeAdmins === 0);
  }

  console.log('\n[126] RBAC shared store — contract shape and leakage (021G)');
  {
    const p = readFileSync('src/lib/it-agent/rbac/persistence.ts', 'utf8');
    const m = readFileSync('src/lib/it-agent/rbac/memory-adapter.ts', 'utf8');
    const g = readFileSync('src/lib/it-agent/rbac/migrate.ts', 'utf8');
    check('grant and audit are ONE method, not a caller-sequenced pair',
      /grantRole\(input: GrantInput\)/.test(p) && !/appendAssignment/.test(p));
    check('final-admin protection lives inside revokeRole',
      /revokeRole/.test(m) && /last_admin_protected/.test(m) &&
      m.indexOf('adminCountSync() <= 1') > m.indexOf('async revokeRole'));
    check('nonce consumption is a single atomic method', /consumePreview\(digest: string/.test(p));
    check('the contract stores a digest, never the raw nonce',
      /digest: string;\s*\/\/ SHA-256/.test(p) && /never the nonce/.test(p));
    check('failures are safe categories, not driver messages',
      /PersistenceFailure =\s*\|\s*'store_unavailable'/.test(p));
    check('no connection string or credential appears in the contract',
      !/password|connectionString|Server=|postgres:\/\/|sslmode/i.test(p + m));
    check('the migration never writes to its source', !/writeFileSync|unlinkSync|rmSync/.test(g));
    check('the migration is documented as fail-closed', /FAIL CLOSED/.test(g));
    check('there is no silent JSON fallback in the adapter',
      !/watson-store\.json|json_legacy/.test(m));
  }

  return { pass, fail, failures };
}
