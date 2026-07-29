/* Runner for the 021G-3 Postgres contract proof. Kept separate from
 * it-agent-selftest so the default self-test stays database-free. */
import { runRbacPostgresContractTests } from './rbac-postgres-contract-021g3.selftest';

async function main(): Promise<void> {
  const r = await runRbacPostgresContractTests();
  console.log(`\n=== POSTGRES CONTRACT: ${r.pass} passed, ${r.fail} failed${r.skipped ? ' (SKIPPED)' : ''} ===`);
  if (r.failures.length) {
    console.log('\nFAILURES:');
    for (const f of r.failures) console.log('  - ' + f);
  }
  process.exit(r.fail > 0 || r.skipped ? 1 : 0);
}
void main();
