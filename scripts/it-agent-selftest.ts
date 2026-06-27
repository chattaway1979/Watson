/* ============================================================
 * Watson — H&R AI IT Agent : Self-Test Harness
 * Run: npm run it-agent:selftest
 * Exercises domain logic + safety guardrails with NO network,
 * NO API keys, and an in-memory (non-persisted) store.
 * ============================================================ */
process.env.IT_AGENT_PERSIST = 'off';
delete process.env.IT_AGENT_LIVE_EXTERNAL_EXECUTION; // ensure default (false)
process.env.AI_PROVIDER = process.env.AI_PROVIDER ?? 'deterministic';

import { __resetDbForTests } from '../src/lib/store/db';
import { seedAll } from '../src/lib/it-agent/seed-knowledge';
import { classifyIssue } from '../src/lib/it-agent/triage';
import { buildTroubleshootingPlan } from '../src/lib/it-agent/troubleshooting';
import { listActions, getAction, assertNoLiveExecutable } from '../src/lib/it-agent/action-registry';
import { createTicket, setStatus, getTicket } from '../src/lib/it-agent/tickets';
import { invokeAction } from '../src/lib/it-agent/tool-gateway';
import { createApprovalRequest, decideApproval, listApprovals } from '../src/lib/it-agent/approval-engine';
import { listAudit } from '../src/lib/it-agent/audit';
import { canPerformAction, canApproveAction, isLiveExternalExecutionEnabled } from '../src/lib/it-agent/policy';
import { getAiProvider, providerInfo } from '../src/lib/it-agent/ai-provider';
import { watsonRespond } from '../src/lib/it-agent/deterministic-agent';
import { mockM365 } from '../src/lib/it-agent/mock-microsoft365';
import { mockDevice } from '../src/lib/it-agent/mock-device-management';
import type { Actor } from '../src/lib/it-agent/types';

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
async function asyncCheck(name: string, fn: () => Promise<boolean>) {
  try { check(name, await fn()); } catch (e) { check(name, false, e instanceof Error ? e.message : String(e)); }
}

const employee: Actor = { id: 'emp1', type: 'user', role: 'employee', email: 'carlos.field@hrelectriccompany.com', displayName: 'Carlos' };
const employee2: Actor = { id: 'emp2', type: 'user', role: 'employee', email: 'dana.est@hrelectriccompany.com', displayName: 'Dana' };
const admin: Actor = { id: 'adm1', type: 'admin', role: 'admin', email: 'admin.it@hrelectriccompany.com', displayName: 'Admin' };
const owner: Actor = { id: 'own1', type: 'admin', role: 'owner', email: 'owner@hrelectriccompany.com', displayName: 'Owner' };
const watson: Actor = { id: 'watson', type: 'agent', role: 'agent', email: 'watson@hrelectriccompany.com', displayName: 'Watson' };

async function main() {
  console.log('\n=== Watson IT Agent Self-Test ===\n');
  __resetDbForTests();
  const seeded = seedAll(true);

  console.log('[1] Seeds & registry');
  check('knowledge base seed exists (>=14 articles)', seeded.articles >= 14, `got ${seeded.articles}`);
  check('mock users seeded', seeded.users >= 4);
  check('mock devices seeded', seeded.devices >= 3);
  check('action registry loads (>=20 actions)', listActions().length >= 20, `got ${listActions().length}`);
  let noLive = true; try { assertNoLiveExecutable(); } catch { noLive = false; }
  check('no action is live-executable', noLive);
  check('every action liveExecutable=false', listActions().every((a) => a.liveExecutable === false));

  console.log('\n[2] Classification & troubleshooting');
  check('classify outlook', classifyIssue('my outlook email is not working').category === 'outlook');
  check('classify password/mfa', classifyIssue('I am locked out and my authenticator code fails').category === 'password_mfa');
  check('classify teams', classifyIssue('teams camera and mic not working in meeting').category === 'teams');
  check('classify printer', classifyIssue('the printer wont print, paper jam').category === 'printer');
  check('classify device_slow', classifyIssue('my computer is so slow and freezing').category === 'device_slow');
  check('classify network', classifyIssue('no internet wifi vpn down').category === 'network');
  check('classify security urgent', (() => { const r = classifyIssue('I think my laptop was stolen and phishing'); return r.category === 'security' && (r.priority === 'urgent' || r.priority === 'high'); })());
  check('classify onboarding', classifyIssue('new hire onboarding start date next week').category === 'onboarding');
  check('classify offboarding', classifyIssue('employee terminated, disable access').category === 'offboarding');
  check('classify other (fallback)', classifyIssue('xyzzy nonsense gibberish').category === 'other');
  const plan = buildTroubleshootingPlan('outlook', 'normal');
  check('troubleshooting plan has steps', plan.steps.length >= 3);
  check('troubleshooting plan has recommended actions', plan.recommendedActions.length >= 1);
  check('troubleshooting plan links KB articles', plan.relatedArticleSlugs.length >= 1);

  console.log('\n[3] Watson fallback AI (no API key)');
  check('provider is deterministic fallback', providerInfo().fallback === true && providerInfo().isLlm === false);
  await asyncCheck('AI triage works without key', async () => {
    const t = await getAiProvider().triage('outlook not receiving email');
    return t.diagnosis.category === 'outlook' && t.plan.steps.length > 0;
  });
  await asyncCheck('watsonRespond returns labeled actions', async () => {
    const r = await watsonRespond(employee, 'I am locked out, need password reset');
    return r.actions.some((a) => a.disposition === 'approval_required') && r.safety.length > 0;
  });

  console.log('\n[4] Ticket lifecycle');
  const ticket = createTicket(employee, { subject: 'Outlook down', description: 'cannot receive mail', category: 'outlook', priority: 'normal' });
  check('ticket creation', !!getTicket(ticket.id) && ticket.shortId.startsWith('WAT-'));
  const t2 = setStatus(admin, ticket.id, 'triaged');
  check('status open->triaged', t2.status === 'triaged');
  const t3 = setStatus(admin, ticket.id, 'in_progress');
  check('status triaged->in_progress', t3.status === 'in_progress');
  const t4 = setStatus(admin, ticket.id, 'resolved');
  check('status in_progress->resolved', t4.status === 'resolved');
  const t5 = setStatus(admin, ticket.id, 'closed');
  check('status resolved->closed', t5.status === 'closed');
  const t6 = setStatus(admin, ticket.id, 'in_progress');
  check('reopen closed->in_progress', t6.status === 'in_progress');
  let illegal = false; try { setStatus(admin, ticket.id, 'open'); } catch { illegal = true; }
  check('illegal transition rejected', illegal);

  console.log('\n[5] Policy & approval gating');
  check('live external execution DISABLED by default', isLiveExternalExecutionEnabled() === false);
  const highDef = getAction('prepare_password_reset')!;
  const critDef = getAction('disable_account')!;
  check('high-risk requires approval (policy)', canPerformAction(admin, 'prepare_password_reset').requiresApproval === true);
  check('critical requires approval (policy)', canPerformAction(owner, 'disable_account').requiresApproval === true);
  check('employee below role for admin lookup', canPerformAction(employee, 'lookup_user').allowed === false);
  check('admin allowed lookup_user (no approval)', (() => { const d = canPerformAction(admin, 'lookup_user'); return d.allowed && !d.requiresApproval; })());

  // Gateway routing
  const gwHigh = invokeAction(admin, { actionKey: 'prepare_password_reset', input: { email: 'dana.est@hrelectriccompany.com', reason: 'locked out' } });
  check('high-risk action => approval_required (not executed)', gwHigh.kind === 'approval_required');
  const gwCrit = invokeAction(owner, { actionKey: 'disable_account', input: { email: 'dana.est@hrelectriccompany.com', reason: 'offboarding' } });
  check('critical action => approval_required (not executed)', gwCrit.kind === 'approval_required');
  const gwSafe = invokeAction(admin, { actionKey: 'lookup_user', input: { email: 'sarah.office@hrelectriccompany.com' } });
  check('safe read action => read_result', gwSafe.kind === 'read_result');
  const gwMock = invokeAction(admin, { actionKey: 'trigger_device_sync_mock', input: { deviceId: 'x' } });
  check('mock-executable action => mock_result (distinct from live)', gwMock.kind === 'mock_result');

  console.log('\n[6] Approvals: who can decide');
  const highReq = createApprovalRequest(admin, { actionKey: 'prepare_password_reset', targetType: 'microsoft365', targetId: 'dana.est@hrelectriccompany.com', payload: { email: 'dana.est@hrelectriccompany.com' } });
  // Watson cannot approve
  let agentBlocked = false; try { decideApproval(watson, highReq.id, 'approved'); } catch { agentBlocked = true; }
  check('agent/Watson cannot approve', agentBlocked);
  check('canApproveAction(agent)=false', canApproveAction(watson, highDef) === false);
  // Self-approval blocked
  let selfBlocked = false; try { decideApproval(admin, highReq.id, 'approved'); } catch { selfBlocked = true; }
  check('requester cannot approve own request', selfBlocked);
  // Employee cannot approve admin action
  let empBlocked = false; try { decideApproval(employee, highReq.id, 'approved'); } catch { empBlocked = true; }
  check('employee cannot approve admin action', empBlocked);
  // Admin (different actor) approves eligible high action => mock executed
  const decision = decideApproval(owner, highReq.id, 'approved', 'ok');
  check('admin/owner can approve eligible high action', decision.approval.status === 'approved');
  check('approved high action mock-executed (not live)', decision.mockExecuted === true && decision.liveBlocked === false);

  console.log('\n[7] Critical approval requires owner');
  const critReq2 = createApprovalRequest(owner, { actionKey: 'wipe_device', targetType: 'device_rmm', targetId: 'dev1', payload: { deviceId: 'dev1' } });
  check('admin cannot approve critical (canApproveAction)', canApproveAction(admin, getAction('wipe_device')!) === false);
  check('owner can approve critical (canApproveAction)', canApproveAction(owner, getAction('wipe_device')!) === true);
  // owner cannot self-approve; use a second owner-tier actor
  const owner2: Actor = { id: 'own2', type: 'admin', role: 'owner', email: 'owner2@hrelectriccompany.com', displayName: 'Owner2' };
  const critDecision2 = decideApproval(owner2, critReq2.id, 'approved', 'reviewed');
  check('critical approval is LIVE-BLOCKED, not executed', critDecision2.liveBlocked === true && critDecision2.mockExecuted === false);

  console.log('\n[8] Reject path + audit');
  const rejReq = createApprovalRequest(admin, { actionKey: 'prepare_mfa_reset', targetType: 'microsoft365', targetId: 'y@hrelectriccompany.com', payload: { email: 'y@hrelectriccompany.com' } });
  const rej = decideApproval(owner, rejReq.id, 'rejected', 'not needed');
  check('rejected approval => status rejected, nothing executed', rej.approval.status === 'rejected' && rej.mockExecuted === false);
  check('approval_requested audit written', listAudit({ action: 'approval_requested' }).length >= 3);
  check('approval_approved audit written', listAudit({ action: 'approval_approved' }).length >= 1);
  check('approval_rejected audit written', listAudit({ action: 'approval_rejected' }).length >= 1);
  check('mock_action_executed audit written', listAudit({ action: 'mock_action_executed' }).length >= 1);
  check('ticket_created audit written', listAudit({ action: 'ticket_created' }).length >= 1);
  check('policy_decision_recorded audit written', listAudit({ action: 'policy_decision_recorded' }).length >= 1);

  console.log('\n[9] Mock connectors');
  check('M365 mock lookupUser works', mockM365.lookupUser('sarah.office@hrelectriccompany.com', admin)?.displayName === 'Sarah Office');
  check('M365 mock MFA status works', mockM365.checkMfaStatus('mike.pm@hrelectriccompany.com', admin)?.mfaEnabled === true);
  check('M365 mock prepare is preparatory only', (mockM365.preparePasswordReset('a@b.com', admin) as any).prepared === true);
  check('M365 mock unknown user => null', mockM365.lookupUser('nobody@nowhere.com', admin) === null);
  const dev = mockDevice.lookupDeviceByEmail('dana.est@hrelectriccompany.com', admin);
  check('Device mock lookup works', dev?.deviceName === 'HRE-EST-03');
  check('Device mock status works', !!mockDevice.checkDeviceStatus(dev!.id, admin));
  check('Device mock sync simulated', mockDevice.triggerSyncMock(dev!.id, admin).syncQueued === true);
  check('connector_mock_called audit written', listAudit({ action: 'connector_mock_called' }).length >= 1);

  console.log('\n[10] Live-execution master gate');
  check('isLiveExternalExecutionEnabled() === false', isLiveExternalExecutionEnabled() === false);

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('ALL SELFTESTS PASSED ✅\n');
  process.exit(0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
