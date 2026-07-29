/* ============================================================
 * Watson — 021G-3 : Postgres adapter and store-selection, DETERMINISTIC.
 * NO network, NO database, NO real identity. Runs on every self-test.
 * ------------------------------------------------------------
 * These are the assertions about the Postgres work that do NOT need a database:
 * where the locks sit, that SQL is parameterised, that no credential can leak,
 * that the schema pins the invariants, and that store selection fails closed
 * rather than degrading to JSON.
 *
 * The behavioural proof — the full 021G-1 contract executed against real
 * PostgreSQL transactions — lives in rbac-postgres-contract-021g3.selftest.ts
 * and is run explicitly, because it needs a server.
 * ============================================================ */
import { readFileSync } from 'node:fs';
import {
  configuredStoreKind, validateStoreConfiguration, buildPostgresStore,
  rbacStoreProvenance, StoreConfigurationError, __setRbacStoreForTests, rbacStore
} from '../src/lib/it-agent/rbac/store-provider';

export async function runRbacPostgresStructureTests(): Promise<{ pass: number; fail: number; failures: string[] }> {
  let pass = 0, fail = 0; const failures: string[] = [];
  const check = (n: string, c: boolean, d = '') => {
    if (c) { pass++; console.log('  ✅ ' + n); }
    else { fail++; failures.push(n + (d ? ` — ${d}` : '')); console.log('  ❌ ' + n + (d ? ` — ${d}` : '')); }
  };

  console.log('\n[134] Postgres adapter — locking, parameterisation and leakage (021G-3)');
  {
    const a = readFileSync('src/lib/it-agent/rbac/postgres-adapter.ts', 'utf8');
    const q = readFileSync('src/lib/it-agent/rbac/postgres-schema.sql', 'utf8');

    // Sliced to revokeRole's OWN body, so this cannot be satisfied by a lock that
    // happens to appear somewhere else in the file.
    const revokeStart = a.indexOf('async revokeRole');
    const revokeBody = a.slice(revokeStart, a.indexOf('  // ---- previews', revokeStart));
    check('revokeRole was located for inspection', revokeStart > 0 && revokeBody.length > 400,
      `start=${revokeStart} len=${revokeBody.length}`);
    check('revokeRole takes the administrator-set lock BEFORE counting administrators',
      revokeBody.indexOf('lockAdminSet(c)') > 0 &&
      revokeBody.indexOf('lockAdminSet(c)') < revokeBody.indexOf('COUNT(DISTINCT principal_object_id)'));
    check('revokeRole counts administrators BEFORE deactivating the assignment',
      revokeBody.indexOf('COUNT(DISTINCT principal_object_id)') < revokeBody.indexOf('SET active = FALSE'));
    check('final-administrator protection lives inside revokeRole, not in a caller',
      revokeBody.includes('last_admin_protected'));
    check('the target assignment is locked FOR UPDATE inside revokeRole',
      /AND active FOR UPDATE/.test(revokeBody));
    check('every administrator-set mutation takes the same advisory lock',
      (a.match(/lockAdminSet\(c\)/g) ?? []).length >= 3,
      String((a.match(/lockAdminSet\(c\)/g) ?? []).length));
    check('the advisory lock is transaction-scoped, so a dropped connection releases it',
      /pg_advisory_xact_lock/.test(a) && !/pg_advisory_lock\(/.test(a));
    check('grant, revoke and bootstrap all serialise on ONE constant lock key',
      (a.match(/ADMIN_SET_LOCK/g) ?? []).length >= 2 && /const ADMIN_SET_LOCK = \d[\d_]*n;/.test(a));

    check('nonce consumption is guarded by consumed_at IS NULL in SQL',
      /SET consumed_at = now\(\) WHERE nonce_digest = \$1 AND consumed_at IS NULL/.test(a));
    check('the nonce row is locked FOR UPDATE before it is inspected',
      /SELECT \* FROM rbac_preview_nonce WHERE nonce_digest = \$1 FOR UPDATE/.test(a));
    check('the preview state version is re-read inside the consuming transaction',
      /c\.query<\{ v: string \}>\([\s\S]{0,120}SUM\(version\)/.test(a));

    // No string-built SQL: every value must be a bound parameter.
    const sqlLines = a.split('\n').filter((l) => /\b(SELECT|INSERT|UPDATE|DELETE|TRUNCATE)\b/.test(l));
    check('SQL lines were found to inspect', sqlLines.length > 20, String(sqlLines.length));
    check('no SQL value is interpolated into a query string',
      !sqlLines.some((l) => /\$\{/.test(l)),
      sqlLines.filter((l) => /\$\{/.test(l)).slice(0, 1).join('').trim().slice(0, 80));
    check('values reach the database as bound parameters',
      (a.match(/\$\d/g) ?? []).length > 30, String((a.match(/\$\d/g) ?? []).length));
    check('the only interpolated identifier is a validated schema name',
      /function quoteIdent/.test(a) && /\^\[a-z_\]\[a-z0-9_\]\{0,62\}\$/.test(a));

    check('no password, connection string or secret appears in the adapter',
      !/password\s*[:=]\s*['"]|postgres:\/\/|sslmode=|Server=|AccountKey/i.test(a));
    check('the adapter authenticates with a managed-identity token, not a stored secret',
      /ManagedIdentityCredential/.test(a) && !/DefaultAzureCredential/.test(a));
    check('the token is supplied through a callback, never materialised in config',
      /password: this\.cfg\.getAccessToken/.test(a));
    check('the token is refreshed before expiry rather than used until it fails',
      /expiresOnMs - Date\.now\(\) > 120_000/.test(a));

    // Every failure the adapter RETURNS must be a safe literal or the classifier.
    const reasons = [...a.matchAll(/ok:\s*false[^,]*,\s*reason:\s*([^,\n}]+)/g)].map((m) => m[1].trim());
    const derived = (r: string) => /\bmessage\b|String\(|JSON\.stringify|`|\+|\.detail|\.hint|\.stack/.test(r);
    const literal = (r: string) => /^'[a-z_]+'( as const)?$/.test(r);
    const classifier = (r: string) => /^PostgresRbacStore\.classify\(\w+\)$/.test(r);
    const unsafe = reasons.filter((r) => derived(r) || !(literal(r) || classifier(r)));
    check('failure reasons were found and inspected', reasons.length >= 12, String(reasons.length));
    check('no failure reason is derived from a driver error', unsafe.length === 0, unsafe.slice(0, 2).join(' | '));
    check('driver errors pass through a single classifier',
      /private static classify/.test(a) && !/JSON\.stringify\(e\)/.test(a));
    check('a connection-level error is classified as store_unavailable, not a persistence bug',
      /!\/\^\[0-9A-Z\]\{5\}\$\/\.test\(code\)\) return 'store_unavailable'/.test(a));
    check('there is no silent JSON fallback in the Postgres adapter',
      !/watson-store\.json|JsonRbacStore|json_legacy/.test(a));
    check('the destructive test reset is gated behind an explicit environment opt-in',
      /WATSON_PG_ALLOW_RESET !== 'yes'/.test(a));

    // Schema-level invariants: a constraint holds under concurrency, a comment does not.
    check('at most one ACTIVE assignment per principal+role is enforced by a UNIQUE index',
      /CREATE UNIQUE INDEX IF NOT EXISTS rbac_assignment_active_uniq[\s\S]{0,120}WHERE active/.test(q));
    check('the audit table is keyed so a replayed insert collides instead of duplicating',
      /audit_id\s+TEXT\s+NOT NULL PRIMARY KEY/.test(q));
    check('a nonce digest must be a sha256 hex string at the database level',
      /nonce_digest ~ '\^\[0-9a-f\]\{64\}\$'/.test(q));
    check('bootstrap cannot record two rows, by construction',
      /rbac_bootstrap_state[\s\S]{0,200}singleton\s+BOOLEAN\s+NOT NULL PRIMARY KEY/.test(q));
    check('the schema is idempotent, so a restart never fails on DDL',
      (q.match(/IF NOT EXISTS/g) ?? []).length >= 8, String((q.match(/IF NOT EXISTS/g) ?? []).length));
    check('roles are constrained to the known set by the database',
      /CONSTRAINT rbac_assignment_role_known CHECK/.test(q));
    check('audit outcomes are constrained by the database',
      /CONSTRAINT rbac_audit_outcome_known CHECK/.test(q));
    check('the schema carries a version row so a future migration is not guesswork',
      /rbac_schema_version/.test(q));
    check('the raw nonce has no column to be stored in',
      !/nonce_raw|raw_nonce|nonce\s+TEXT/.test(q));

    // A bundled standalone build may not have the .sql file beside the module, so
    // the adapter falls back to EMBEDDED_SCHEMA. If the two ever drift, a deployed
    // worker would create a DIFFERENT schema from the one these tests validate —
    // silently. Pin them to the same objects and constraints.
    const embedded = a.slice(a.indexOf('const EMBEDDED_SCHEMA = `'));
    const objectsOf = (sql: string) => [
      ...[...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => 'table:' + m[1]),
      ...[...sql.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/g)].map((m) => 'index:' + m[1]),
      ...[...sql.matchAll(/CONSTRAINT (\w+)/g)].map((m) => 'constraint:' + m[1])
    ].sort();
    const fileObjects = objectsOf(q);
    const embObjects = objectsOf(embedded);
    check('the embedded fallback schema was located', embedded.length > 800 && embObjects.length > 10,
      `len=${embedded.length} objects=${embObjects.length}`);
    check('the embedded fallback schema defines the SAME objects as the .sql file',
      fileObjects.join('|') === embObjects.join('|'),
      `only in file: ${fileObjects.filter((x) => !embObjects.includes(x))} | only in embedded: ${embObjects.filter((x) => !fileObjects.includes(x))}`);
    // Formatting-independent: strip SQL comments, collapse whitespace, then read
    // `<name> <TYPE>` pairs. The .sql file is formatted one column per line and the
    // embedded copy is compact, so any line-based comparison would be meaningless.
    const colsOf = (sql: string) => [...sql
      .replace(/--[^\n]*/g, ' ')
      .replace(/\s+/g, ' ')
      .matchAll(/(\w+) (TEXT|BOOLEAN|INTEGER|TIMESTAMPTZ|JSONB|UUID)\b/g)]
      .map((m) => m[1] + ':' + m[2]).sort();
    check('the embedded fallback schema declares the SAME columns and types',
      colsOf(q).join('|') === colsOf(embedded).join('|'),
      `file=${colsOf(q).length} embedded=${colsOf(embedded).length}`);
  }

  console.log('\n[135] RBAC store selection — postgres is real and fails closed (021G-3)');
  {
    const base = { WATSON_RBAC_PG_HOST: 'h', WATSON_RBAC_PG_DATABASE: 'd', WATSON_RBAC_PG_USER: 'u' };

    check('an absent setting still means json, so nothing changed by accident',
      configuredStoreKind({} as unknown as NodeJS.ProcessEnv) === 'json');
    check('an unrecognised store value is a configuration error, never a fallback', (() => {
      try { configuredStoreKind({ WATSON_RBAC_STORE: 'sqlite' } as unknown as NodeJS.ProcessEnv); return false; }
      catch (e) { return e instanceof StoreConfigurationError; }
    })());

    const okCfg = { WATSON_RBAC_STORE: 'postgres', ...base } as unknown as NodeJS.ProcessEnv;
    const v = validateStoreConfiguration(okCfg);
    check('a fully configured postgres store validates', v.ok === true && v.kind === 'postgres',
      JSON.stringify(v.reasonCodes));

    for (const [missing, code] of [
      ['WATSON_RBAC_PG_HOST', 'rbac_store_pg_host_missing'],
      ['WATSON_RBAC_PG_DATABASE', 'rbac_store_pg_database_missing'],
      ['WATSON_RBAC_PG_USER', 'rbac_store_pg_user_missing']
    ] as Array<[string, string]>) {
      const env = { WATSON_RBAC_STORE: 'postgres', ...base } as unknown as Record<string, string>;
      delete env[missing];
      const r = validateStoreConfiguration(env as unknown as NodeJS.ProcessEnv);
      check(`postgres without ${missing} is refused as ${code}`,
        r.ok === false && r.reasonCodes.includes(code), JSON.stringify(r.reasonCodes));
    }

    // A configured password means a secret is sitting where Entra auth was the
    // point. That is refused rather than honoured.
    const withPw = validateStoreConfiguration({
      WATSON_RBAC_STORE: 'postgres', ...base, WATSON_RBAC_PG_PASSWORD: 'anything'
    } as unknown as NodeJS.ProcessEnv);
    check('a configured database password is REFUSED, not used',
      withPw.ok === false && withPw.reasonCodes.includes('rbac_store_pg_password_forbidden'),
      JSON.stringify(withPw.reasonCodes));

    check('buildPostgresStore throws on a misconfiguration instead of returning something usable', (() => {
      try { buildPostgresStore({ WATSON_RBAC_STORE: 'postgres' } as unknown as NodeJS.ProcessEnv); return false; }
      catch (e) { return e instanceof StoreConfigurationError; }
    })());
    check('the misconfiguration message carries reason CODES and no configured values', (() => {
      try { buildPostgresStore({ WATSON_RBAC_STORE: 'postgres', WATSON_RBAC_PG_HOST: 'secret-host.example' } as unknown as NodeJS.ProcessEnv); return false; }
      catch (e) { return !/secret-host/.test((e as Error).message); }
    })());

    // Construction must not require a live database, but must produce a postgres
    // adapter — this is what proves the 021G-2 inert stub is gone.
    __setRbacStoreForTests(null);
    const built = buildPostgresStore(okCfg);
    check('a configured postgres store constructs a real postgres adapter', built.kind === 'postgres');
    check('constructing the adapter does not require a reachable database', built !== null);
    check('no credential is present on the constructed adapter',
      !JSON.stringify(Object.keys(built)).includes('password'));

    __setRbacStoreForTests(null);
    const chosen = rbacStore(okCfg);
    check('rbacStore returns the postgres adapter when postgres is selected', chosen.kind === 'postgres');
    __setRbacStoreForTests(null);

    check('postgres is reported multi-instance safe',
      rbacStoreProvenance(okCfg).multiInstanceSafe === true);
    check('json is reported NOT multi-instance safe',
      rbacStoreProvenance({ WATSON_RBAC_STORE: 'json' } as unknown as NodeJS.ProcessEnv).multiInstanceSafe === false);
    check('provenance never reports a host, database or user', (() => {
      const p = JSON.stringify(rbacStoreProvenance(okCfg));
      return !/"h"|"d"|"u"|host|database|user/i.test(p);
    })());

    const sp = readFileSync('src/lib/it-agent/rbac/store-provider.ts', 'utf8');
    check('store selection has no path that falls back to JSON once postgres is chosen',
      !/catch[\s\S]{0,160}new JsonRbacStore/.test(sp));
    check('the 021G-2 inert postgres stub is gone',
      !/adapter is not available in this build/.test(sp));
  }

  return { pass, fail, failures };
}
