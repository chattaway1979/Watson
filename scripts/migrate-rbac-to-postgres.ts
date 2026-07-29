/* ============================================================
 * Watson — 021G-3 : migrate RBAC state from the JSON store to PostgreSQL.
 * ------------------------------------------------------------
 * Reads a LOCAL BACKUP of the JSON store. It never reads the live runtime store
 * directly and never writes to its source, so a failed run cannot damage the
 * thing being rolled back to.
 *
 * Default is a DRY RUN. Nothing is written without --apply.
 *
 * Idempotent by identity: assignments key on assignmentId, audit on id, and the
 * bootstrap row on its singleton. A rerun therefore inserts nothing rather than
 * duplicating, and that is asserted at the end of every run.
 *
 * Usage:
 *   npx tsx scripts/migrate-rbac-to-postgres.ts <backup.json>            # dry run
 *   npx tsx scripts/migrate-rbac-to-postgres.ts <backup.json> --apply
 * ============================================================ */
import { readFileSync } from 'node:fs';
import { planMigration, applyMigration, MigrationError } from '../src/lib/it-agent/rbac/migrate';
import { PostgresRbacStore, type PostgresStoreConfig } from '../src/lib/it-agent/rbac/postgres-adapter';

async function entraToken(): Promise<string> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const { stdout } = await run('az', ['account', 'get-access-token',
    '--resource', 'https://ossrdbms-aad.database.windows.net',
    '--query', 'accessToken', '-o', 'tsv'], { shell: true, maxBuffer: 1024 * 1024 });
  const t = stdout.trim();
  if (!t) throw new Error('token_unavailable');
  return t;
}

function fail(msg: string): never {
  console.error('\nBLOCKED: ' + msg);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const apply = args.includes('--apply');
  if (!file) fail('a backup file path is required');

  const host = process.env.WATSON_RBAC_PG_HOST;
  const database = process.env.WATSON_RBAC_PG_DATABASE;
  const user = process.env.WATSON_RBAC_PG_USER;
  if (!host || !database || !user) fail('WATSON_RBAC_PG_HOST / _DATABASE / _USER must be set');

  console.log(`\n=== RBAC MIGRATION — ${apply ? 'APPLY' : 'DRY RUN'} ===`);

  // ---- source ----------------------------------------------------------
  const raw = readFileSync(file!, 'utf8');
  const { createHash } = await import('node:crypto');
  const fileSha = createHash('sha256').update(raw).digest('hex');
  console.log(`  source file      : ${file}`);
  console.log(`  source file sha256: ${fileSha}`);

  let plan;
  try {
    plan = planMigration(JSON.parse(raw));
  } catch (e) {
    if (e instanceof MigrationError) fail(`source rejected fail-closed: ${e.message}`);
    throw e;
  }
  console.log(`  assignments      : ${plan.sourceCounts.assignments}`);
  console.log(`  audit rows       : ${plan.sourceCounts.audit}`);
  console.log(`  active admins    : ${plan.sourceCounts.activeAdmins}`);
  console.log(`  content checksum : ${plan.checksum}`);

  // A migration that would leave Watson with no administrator is refused here,
  // before it can touch the destination.
  if (plan.sourceCounts.activeAdmins < 1) {
    fail('the source has NO active administrator; migrating it could leave Watson unadministrable');
  }

  // Bootstrap must survive, not just assignments and audit.
  const src = JSON.parse(raw) as { rbacAudit?: Array<Record<string, unknown>> };
  const bootEvents = (src.rbacAudit ?? []).filter(
    (e) => e.operation === 'bootstrap' && e.outcome === 'success');
  const bootOid = bootEvents.length ? String(bootEvents[bootEvents.length - 1].targetOid) : null;
  console.log(`  bootstrap state  : ${bootOid ? 'completed for ' + bootOid : 'none recorded in source'}`);

  const cfg: PostgresStoreConfig = {
    host, database, user, port: Number(process.env.WATSON_RBAC_PG_PORT ?? 5432),
    getAccessToken: entraToken, ssl: true,
    connectionTimeoutMillis: 20_000, statementTimeoutMillis: 60_000, maxConnections: 4
  };
  const dest = new PostgresRbacStore(cfg);

  try {
    await dest.ensureSchema();
    if (!(await dest.ping())) fail('the destination database is not reachable');

    const before = {
      assignments: (await dest.allAssignments()).length,
      audit: await dest.auditRowCount(),
      admins: await dest.countActiveRoleAdmins(),
      bootstrap: await dest.bootstrapState()
    };
    console.log(`\n  destination BEFORE: assignments=${before.assignments} audit=${before.audit} admins=${before.admins} bootstrap=${before.bootstrap ? 'set' : 'unset'}`);
    console.log(`  prior migrations  : ${JSON.stringify(await dest.migrationHistory())}`);

    if (!apply) {
      console.log('\n  DRY RUN — nothing was written. Re-run with --apply to migrate.');
      return;
    }

    // ---- apply -----------------------------------------------------------
    const rep = await applyMigration(plan, dest as never);
    if (bootOid) {
      const b = await dest.importBootstrapState(bootOid);
      console.log(`  bootstrap state   : ${b}`);
    }
    await dest.recordMigration({
      migrationId: `json-to-pg-${plan.checksum.slice(0, 16)}`,
      sourceKind: 'json_legacy', sourceChecksum: plan.checksum,
      assignments: plan.sourceCounts.assignments, auditRows: plan.sourceCounts.audit
    });

    console.log(`  inserted          : assignments=${rep.inserted.assignments} audit=${rep.inserted.audit}`);
    console.log(`  skipped (existing): assignments=${rep.skipped.assignments} audit=${rep.skipped.audit}`);
    console.log(`  destination counts: ${JSON.stringify(rep.destinationCounts)}`);
    console.log(`  verified          : ${rep.verified}`);
    if (!rep.verified) fail('destination verification FAILED — the migration did not preserve the source');

    // ---- verify every source record is actually present -------------------
    const destAll = await dest.allAssignments();
    const destIds = new Set(destAll.map((a) => a.assignmentId));
    const missingA = plan.assignments.filter((a) => !destIds.has(a.assignmentId));
    const destAudit = await dest.listAudit({ limit: 500 });
    const destAuditIds = new Set(destAudit.map((e) => e.id));
    const missingE = plan.audit.filter((e) => !destAuditIds.has(e.id));
    console.log(`  missing assignments: ${missingA.length}   missing audit rows: ${missingE.length}`);
    if (missingA.length || missingE.length) fail('records were dropped during migration');

    // Active-role equivalence, principal by principal.
    const principals = [...new Set(plan.assignments.map((a) => a.targetOid))];
    let mismatch = 0;
    for (const p of principals) {
      const expected = [...new Set(plan.assignments.filter((a) => a.targetOid === p && a.active).map((a) => a.role))].sort();
      const actual = await dest.activeRoles(p);
      if (expected.join() !== actual.join()) { mismatch++; console.log(`  ROLE MISMATCH for ${p}: expected ${expected} got ${actual}`); }
    }
    console.log(`  principals checked: ${principals.length}   role mismatches: ${mismatch}`);
    if (mismatch) fail('active roles differ between source and destination');

    const bs = await dest.bootstrapState();
    console.log(`  bootstrap preserved: ${bs ? bs.oid : 'NONE'}`);
    if (bootOid && (!bs || bs.oid !== bootOid)) fail('bootstrap state was not preserved');

    // ---- idempotency: a rerun must insert nothing ------------------------
    const rerun = await applyMigration(plan, dest as never);
    console.log(`\n  RERUN inserted    : assignments=${rerun.inserted.assignments} audit=${rerun.inserted.audit}`);
    console.log(`  RERUN idempotent  : ${rerun.idempotentRerun}`);
    if (!rerun.idempotentRerun) fail('the migration is NOT idempotent — a rerun inserted rows');
    const after = (await dest.allAssignments()).length;
    if (after !== destAll.length) fail(`a rerun changed the assignment count (${destAll.length} -> ${after})`);
    console.log(`  assignment count stable after rerun: ${after}`);
    console.log(`  admins after      : ${await dest.countActiveRoleAdmins()}`);
    console.log('\n  MIGRATION COMPLETE and verified.');
  } finally {
    await dest.close();
  }
}
void main();
