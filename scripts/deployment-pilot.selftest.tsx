/* ============================================================
 * Watson — deployment readiness, health endpoint, and pilot-UX tests.
 * Deterministic + network-free.
 * ============================================================ */
import { renderToStaticMarkup } from 'react-dom/server';
import { deploymentHealth, deploymentConfigValidation } from '../src/lib/it-agent/deployment';
import { GET as healthGET } from '../src/app/api/health/route';
import { startCase } from '../src/lib/it-agent';
import { toEmployeeView } from '../src/lib/it-agent/watson/cases';
import { WatsonShell } from '../src/components/it-agent/watson/WatsonShell';
import type { Actor } from '../src/lib/it-agent/types';

type Env = NodeJS.ProcessEnv;
const env = (o: Record<string, string>) => o as unknown as Env;

export async function runDeploymentPilotTests(): Promise<{ pass: number; fail: number; failures: string[] }> {
  let pass = 0, fail = 0; const failures: string[] = [];
  const check = (name: string, cond: boolean, detail = '') => {
    if (cond) { pass++; console.log('  ✅ ' + name); }
    else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log('  ❌ ' + name + (detail ? ` — ${detail}` : '')); }
  };
  const emp: Actor = { id: 'dp-emp', type: 'user', role: 'employee', email: 'carlos.field@hrelectriccompany.com', displayName: 'Carlos' };

  console.log('\n[49] Deployment readiness & health');
  check('demo mode is healthy', deploymentHealth(env({})).healthy === true);
  check('entra + no admin selector is UNHEALTHY (fail-closed)', deploymentHealth(env({ WATSON_AUTH_MODE: 'entra' })).healthy === false);
  check('entra + admin role is healthy', deploymentHealth(env({ WATSON_AUTH_MODE: 'entra', WATSON_ADMIN_APP_ROLE: 'Watson.Admin' })).healthy === true);
  check('health reports live gates OFF by default', deploymentHealth(env({})).liveReadGateEnabled === false && deploymentHealth(env({})).liveExecutionEnabled === false);
  const hDump = JSON.stringify(deploymentHealth(env({ WATSON_AUTH_MODE: 'entra', WATSON_ADMIN_APP_ROLE: 'Watson.Admin', GRAPH_TENANT_ID: 't-123' })));
  check('health output is value-free (no tenant/role values)', !hDump.includes('t-123') && !hDump.includes('Watson.Admin'));

  // Health route: 200 in demo; 503 when entra misconfigured; no-store.
  const savedMode = process.env.WATSON_AUTH_MODE;
  const ok200 = await healthGET();
  check('GET /api/health => 200 in demo', ok200.status === 200 && (await ok200.json()).status === 'ok');
  check('GET /api/health is no-store', ok200.headers.get('cache-control') === 'no-store');
  try {
    process.env.WATSON_AUTH_MODE = 'entra';
    const r503 = await healthGET();
    check('GET /api/health => 503 when entra misconfigured', r503.status === 503 && (await r503.json()).status === 'misconfigured');
  } finally {
    if (savedMode === undefined) delete process.env.WATSON_AUTH_MODE; else process.env.WATSON_AUTH_MODE = savedMode;
  }

  console.log('\n[50] Pilot UX fixes');
  // Auto-escalated cases now carry a meaningful cause for the report.
  const lost = await startCase(emp, 'I lost my company laptop');
  check('lost-device case has a likely cause for the employee report', toEmployeeView(lost.case).likelyCause !== null);
  const unknown = await startCase(emp, 'the flux capacitor is wobbly');
  check('unknown case has a likely cause (not blank)', toEmployeeView(unknown.case).likelyCause !== null);

  // Employee shell: pilot label + accessible controls, no write/remediation words.
  const shell = renderToStaticMarkup(<WatsonShell />);
  check('shell shows a calm pilot/simulation label', /Pilot — Watson simulates/.test(shell));
  check('shell input has an accessible label', /aria-label="Describe your problem"/.test(shell));
  check('shell mic has an accessible label', /Push to talk \(mock\)/.test(shell));
  check('shell exposes no write/remediation controls', !/disable account|reset password|password reset|delete user|wipe device|remediat|assign license/i.test(shell));

  // 010C responsive/accessibility regressions (deployed employee browser pilot):
  // (1) the composer input must be able to shrink (min-w-0) so the input row does
  //     not overflow horizontally at a 375px viewport. min-w-0 is used ONLY on
  //     the composer input, so its presence in the shell is a precise regression.
  check('shell composer input has min-w-0 (no 375px overflow)', /min-w-0/.test(shell) && /aria-label="Describe your problem"/.test(shell));
  // (2) the attachment control must be keyboard-reachable (label is a focusable
  //     button with an accessible name — the file input itself is display:none).
  check('shell attachment control is keyboard-accessible', /aria-label="Attach a screenshot"/.test(shell) && /tabindex="0"/i.test(shell) && /role="button"/.test(shell));
  // (3) contrast: primary Send action uses sky-700 (>=4.5:1 on white), never the
  //     sub-AA sky-600; safety disclaimer uses slate-400, never sub-AA slate-500.
  check('shell Send button uses AA-contrast sky-700 (not sky-600)', /bg-sky-700[^"]*"[^>]*>Send</.test(shell) && !/bg-sky-600/.test(shell));
  check('shell safety disclaimer uses AA-contrast slate-400 (not slate-500)', /text-slate-400[^"]*"[^>]*>Watson makes no changes/.test(shell) && !/text-slate-500/.test(shell));

  // deploymentConfigValidation stays value-free with codes.
  const dcv = deploymentConfigValidation(env({ WATSON_AUTH_MODE: 'entra' }));
  check('config validation flags missing admin selector', dcv.reasonCodes.includes('admin_selector_missing'));

  return { pass, fail, failures };
}
