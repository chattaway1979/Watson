/* Durability probe (run as a subprocess by pilot-fixes.selftest with
 * IT_AGENT_PERSIST=on and a temp WATSON_DATA_DIR). Creates a case, persists it,
 * drops the in-process singleton to simulate a FRESH process/worker, then
 * re-reads it from the file. Prints DURABLE_OK / DURABLE_FAIL. No network. */
import { save } from '../src/lib/store/db';
import { createCase, getCase } from '../src/lib/it-agent/watson/cases';
import type { Actor } from '../src/lib/it-agent/types';

const emp: Actor = { id: 'dur-emp', type: 'user', role: 'employee', email: 'dur@hrelectriccompany.com', displayName: 'Dur' };
const c = createCase({ actor: emp, platform: 'windows', originalStatement: 'durability check' });
save();

// Simulate a different process / recycled worker: forget the in-memory singleton.
const gg = globalThis as unknown as { __watsonDb?: unknown; __watsonDbMtime?: number };
gg.__watsonDb = undefined;
gg.__watsonDbMtime = undefined;

const reloaded = getCase(c.caseId);
if (reloaded && reloaded.caseId === c.caseId) { console.log('DURABLE_OK'); process.exit(0); }
console.log('DURABLE_FAIL'); process.exit(1);
