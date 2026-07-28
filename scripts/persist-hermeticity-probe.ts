/* Hermeticity probe (run as a subprocess by rbac-local-bootstrap-021c1a.selftest
 * with a temp WATSON_DATA_DIR and persistence NOT pre-disabled in the spawn env).
 *
 * Reproduces the 021C-1A root cause: a harness sets IT_AGENT_PERSIST='off' as the
 * FIRST statement in its module body, but ES module imports are hoisted and
 * evaluated first, so src/lib/store/db.ts has already run. When that module
 * snapshotted the flag into a const, this assignment came too late and the
 * "hermetic" run wrote to the real store on disk.
 *
 * Prints HERMETIC_OK when the write is correctly suppressed and no store file is
 * created. No network. */
process.env.IT_AGENT_PERSIST = 'off';

import { existsSync, readdirSync } from 'node:fs';
import { db, save, storagePosture } from '../src/lib/store/db';

const posture = storagePosture();
const d = db();
d.counters.probe = (d.counters.probe ?? 0) + 1;
save();

const dir = process.env.WATSON_DATA_DIR ?? '';
const leaked = existsSync(posture.dataFile) || (dir && existsSync(dir) && readdirSync(dir).length > 0);

if (posture.persistEnabled) { console.log('HERMETIC_FAIL persistence_enabled_despite_off'); process.exit(1); }
if (leaked) { console.log('HERMETIC_FAIL store_file_written'); process.exit(1); }
console.log('HERMETIC_OK');
process.exit(0);
