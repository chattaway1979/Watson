/* ============================================================
 * Watson — H&R AI IT Agent : Employee experience vertical-slice tests.
 * Invoked from it-agent-selftest.ts. Deterministic + network-free: the engine
 * uses the mock M365 diagnostic system, routes are driven with fabricated
 * Requests, and UI is rendered with react-dom/server. No real mic/voice/Azure.
 * ============================================================ */
import { renderToStaticMarkup } from 'react-dom/server';
import { listAudit } from '../src/lib/it-agent/audit';
import { isLiveExternalExecutionEnabled } from '../src/lib/it-agent/constants';
import {
  startCase, addEmployeeMessage, decideCaseApproval, runSimulatedRepair,
  stopSimulatedRepair, submitVerification, attachScreenshot,
  getCaseForActor, currentOpenCase, listAllCases, runM365Diagnostic
} from '../src/lib/it-agent';
import { toEmployeeView, toAdminView } from '../src/lib/it-agent/watson/cases';
import { GET as watsonGET, POST as watsonPOST } from '../src/app/api/it-agent/watson/route';
import { GET as casesGET } from '../src/app/api/it-agent/cases/route';
import { caseStateToParticleState, PARTICLE_LABELS, WatsonParticles } from '../src/components/it-agent/watson/WatsonParticles';
import { createMockTextToSpeech, createMockSpeechToText, WATSON_VOICE } from '../src/components/it-agent/watson/voice-seam';
import { WatsonShell } from '../src/components/it-agent/watson/WatsonShell';
import type { Actor } from '../src/lib/it-agent/types';

const empA: Actor = { id: 'emp-A', type: 'user', role: 'employee', email: 'carlos.field@hrelectriccompany.com', displayName: 'Carlos' };
const empB: Actor = { id: 'emp-B', type: 'user', role: 'employee', email: 'dana.est@hrelectriccompany.com', displayName: 'Dana' };
const req = (h: Record<string, string>, body?: unknown) =>
  new Request('http://localhost/api/it-agent/watson', { method: body ? 'POST' : 'GET', headers: h, ...(body ? { body: JSON.stringify(body) } : {}) });

export async function runWatsonEmployeeTests(): Promise<{ pass: number; fail: number; failures: string[] }> {
  let pass = 0, fail = 0; const failures: string[] = [];
  const check = (name: string, cond: boolean, detail = '') => {
    if (cond) { pass++; console.log('  ✅ ' + name); }
    else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log('  ❌ ' + name + (detail ? ` — ${detail}` : '')); }
  };
  const SECRET = 'KV-CLIENT-SECRET-DO-NOT-LOG', TOKEN = 'BEARER-TOKEN-SECRET-DO-NOT-LOG';

  // ================================================================
  console.log('\n[39] Employee experience & case lifecycle');
  // ================================================================
  const t = await startCase(empA, 'Outlook keeps asking me to sign in on my Windows laptop');
  check('text starts a case (investigated, proposal)', t.case.state === 'waiting_for_approval' && t.case.scenario === 'outlook_repeated_signin');
  check('screenshot metadata (only) attaches to the case', (() => {
    const c = attachScreenshot(empA, t.case.caseId, { kind: 'screenshot', name: 'err.png', contentType: 'image/png', sizeBytes: 1234 });
    const att = c?.attachments[0] as Record<string, unknown> | undefined;
    return !!att && !('data' in att) && !('bytes' in att) && att.name === 'err.png';
  })());
  check('employee can resume the same open case', currentOpenCase(empA)?.caseId === t.case.caseId);
  check('employee CANNOT access another employee case', getCaseForActor(t.case.caseId, empB) === null);
  const stt = createMockSpeechToText('my onedrive is not syncing');
  stt.start(); const transcript = await stt.stop();
  const voiceCase = await startCase(empB, transcript);
  check('mock voice input starts the same flow', voiceCase.case.scenario === 'onedrive_sync' && stt.listening === false);

  // Route-level: GET resume + auth
  const getRes = await watsonGET(req({ 'x-watson-role': 'employee' }));
  check('authenticated employee GET /watson => 200', getRes.status === 200);
  const savedMode = process.env.WATSON_AUTH_MODE;
  process.env.WATSON_AUTH_MODE = 'entra';
  const unauth = await watsonGET(req({}));
  process.env.WATSON_AUTH_MODE = savedMode ?? '';
  if (savedMode === undefined) delete process.env.WATSON_AUTH_MODE;
  check('unauthenticated under Entra => 401', unauth.status === 401);
  check('WatsonShell shows "How can I help?" before a case', /How can I help\?/.test(renderToStaticMarkup(<WatsonShell />)));

  // ================================================================
  console.log('\n[40] Conversation rules');
  // ================================================================
  const noPlat = await startCase(empA, 'Outlook keeps asking me to sign in');
  check('one focused question when platform unknown', noPlat.case.state === 'waiting_for_employee' && noPlat.case.needs.includes('platform') && Boolean(noPlat.followupQuestion));
  const answered = await addEmployeeMessage(empA, noPlat.case.caseId, 'my windows pc');
  check('answering the question proceeds (no re-ask)', answered?.case.state === 'waiting_for_approval' && !answered?.case.needs.includes('platform'));
  const startWin = await startCase(empA, 'Outlook keeps asking me to sign in on windows');
  const corrected = await addEmployeeMessage(empA, startWin.case.caseId, 'actually this is on my ipad');
  check('correction invalidates the prior device assumption', corrected?.case.platform === 'ipados');
  const techReq = await startCase(empA, 'Outlook keeps asking me to sign in on windows');
  const escTech = await addEmployeeMessage(empA, techReq.case.caseId, 'can I please speak to a technician');
  check('technician request escalates immediately', escTech?.case.state === 'escalated');
  const lost = await startCase(empA, 'I lost my company laptop');
  check('lost device escalates to security', lost.case.escalation.escalated && lost.case.escalation.securityFlag === true && lost.case.escalation.routingCategory === 'Security');
  const unknown = await startCase(empA, 'the wobblenator is broken');
  check('unknown issue escalates safely', unknown.case.scenario === 'unknown' && unknown.case.escalation.escalated);

  // ================================================================
  console.log('\n[41] Diagnostics (plan + evidence honesty)');
  // ================================================================
  const outlook = await startCase(empA, 'Outlook keeps asking me to sign in on windows');
  check('outlook selects account/license/mailbox/sign-in checks', outlook.case.evidence.some((e) => /account/i.test(e.check)) && outlook.case.evidence.some((e) => /sign-in/i.test(e.check)));
  const sp = await startCase(empA, 'I cannot access the SharePoint project folder');
  check('sharepoint selects account + group checks', sp.case.diagnosticPlan.some((p) => /group/i.test(p)));
  const teams = await startCase(empA, 'Teams camera does not work on my ipad');
  check('ipad teams selects device + app checks', teams.case.evidence.some((e) => /device/i.test(e.check)));
  const od = await startCase(empA, 'my onedrive is not syncing on windows');
  check('onedrive selects account + sync checks', od.case.scenario === 'onedrive_sync' && od.case.evidence.length >= 2);
  // "Unavailable/unknown evidence is not fabricated as healthy" — proven at the
  // diagnostic layer. (Pilot CASE users get a deterministic mock identity so their
  // own flow can resolve; an arbitrary unknown target still returns not_found.)
  const adminDiag: Actor = { id: 'adm-diag', type: 'admin', role: 'admin', email: 'admin.it@hrelectriccompany.com', displayName: 'Admin' };
  const ghost = await runM365Diagnostic(adminDiag, 'lookup_user', 'ghost-unseeded@nowhere.invalid');
  check('unavailable/unknown evidence is NOT fabricated as healthy', ghost.outcome === 'evidence' && ghost.result.state !== 'ok' && ghost.result.data === null);
  check('raw diagnostic payloads never reach the employee view', (() => {
    const v = JSON.stringify(toEmployeeView(outlook.case));
    return !v.includes('@odata') && !v.includes('onPremises') && !v.includes('userPrincipalName') && !v.includes(TOKEN) && !v.includes(SECRET);
  })());

  // ================================================================
  console.log('\n[42] Triple-check');
  // ================================================================
  check('all three gates pass for a healthy Outlook case', outlook.case.tripleCheck?.passed === true && outlook.case.tripleCheck.diagnosisGate.passed && outlook.case.tripleCheck.suitabilityGate.passed && outlook.case.tripleCheck.safetyGate.passed);
  check('failed suitability gate (no safe repair) blocks + escalates', sp.case.state === 'escalated' && sp.case.tripleCheck?.suitabilityGate.passed === false);
  check('unknown target stays honest (never a confident healthy claim)', ghost.outcome === 'evidence' && ghost.result.state === 'not_found');
  check('confidence is only high/moderate/low', ['high', 'moderate', 'low'].includes(String(outlook.case.confidence)));
  check('no fake percentage in employee-facing confidence', !/\d+\s*%/.test(JSON.stringify(toEmployeeView(outlook.case))));
  check('proposed repair is employee-approvable (safety gate)', outlook.case.proposedSolution?.approvalLevel === 'employee');

  // ================================================================
  console.log('\n[43] Time estimation');
  // ================================================================
  check('valid repair path produces a range', outlook.case.estimate?.known === true && /About \d+–\d+ minutes/.test(outlook.case.estimate.label));
  check('unknown/escalated path has no fabricated estimate', sp.case.estimate?.known === false);
  check('escalation separates response and repair estimates', typeof lost.case.estimate?.responseLabel === 'string' && typeof lost.case.estimate?.repairAfterReviewLabel === 'string');

  // ================================================================
  console.log('\n[44] Approval');
  // ================================================================
  const ap = await startCase(empA, 'Outlook keeps asking me to sign in on windows');
  check('employee-level action requires explicit approval', ap.case.state === 'waiting_for_approval' && ap.case.approval.state === 'requested');
  const ambiguous = await addEmployeeMessage(empA, ap.case.caseId, 'hmm maybe');
  check('ambiguous text is NOT approval', getCaseForActor(ap.case.caseId, empA)?.approval.state === 'requested');
  const runBefore = runSimulatedRepair(empA, ap.case.caseId);
  check('action cannot run before approval', getCaseForActor(ap.case.caseId, empA)?.runs.length === 0 && /approval/i.test(runBefore?.reply ?? ''));
  const declined = decideCaseApproval(empA, ap.case.caseId, 'decline');
  check('decline causes no simulated change', declined?.case.approval.state === 'declined' && declined?.case.runs.length === 0);

  // ================================================================
  console.log('\n[45] Simulation');
  // ================================================================
  const sim = await startCase(empA, 'Outlook keeps asking me to sign in on windows');
  decideCaseApproval(empA, sim.case.caseId, 'approve');
  const ran = runSimulatedRepair(empA, sim.case.caseId);
  check('before-state recorded', !!ran?.case.runs[0].beforeState);
  check('only the approved action runs and completes (mock)', ran?.case.runs.length === 1 && ran?.case.runs[0].status === 'completed');
  check('simulated completion alone does NOT resolve', ran?.case.state === 'waiting_for_verification');
  const stopped = stopSimulatedRepair(empA, sim.case.caseId);
  check('safe-stop returns without change', stopped?.case.state === 'waiting_for_employee');

  // ================================================================
  console.log('\n[46] Verification');
  // ================================================================
  const v1 = await startCase(empA, 'Outlook keeps asking me to sign in on windows');
  decideCaseApproval(empA, v1.case.caseId, 'approve'); runSimulatedRepair(empA, v1.case.caseId);
  const works = submitVerification(empA, v1.case.caseId, 'works');
  check('employee confirmation resolves after system verification', works?.case.state === 'resolved');
  const v2 = await startCase(empA, 'Outlook keeps asking me to sign in on windows');
  decideCaseApproval(empA, v2.case.caseId, 'approve'); runSimulatedRepair(empA, v2.case.caseId);
  const stillBroken = submitVerification(empA, v2.case.caseId, 'still_broken');
  check('failure returns to same case (reopened, not resolved)', stillBroken?.case.caseId === v2.case.caseId && stillBroken?.case.state === 'escalated' && stillBroken?.case.runs[0].status === 'unexpected_state');
  const v3 = await startCase(empA, 'Outlook keeps asking me to sign in on windows');
  decideCaseApproval(empA, v3.case.caseId, 'approve'); runSimulatedRepair(empA, v3.case.caseId);
  const partial = submitVerification(empA, v3.case.caseId, 'partial');
  check('partial success remains open', partial?.case.state === 'waiting_for_employee');

  // ================================================================
  console.log('\n[47] Escalation, reports & admin');
  // ================================================================
  const adminView = toAdminView(stillBroken!.case);
  check('technician brief contains structured evidence/hypotheses', Array.isArray(adminView.evidence) && Array.isArray(adminView.hypotheses) && !!adminView.adminReport);
  check('priority follows impact (lost device urgent)', lost.case.priority === 'urgent');
  check('routing category preserved on escalation', sp.case.escalation.routingCategory === 'Microsoft 365');
  check('employee sees response + repair estimates on escalation', !!toEmployeeView(lost.case).estimate?.responseLabel);
  check('escalation keeps transcript + evidence', stillBroken!.case.messages.length > 0 && stillBroken!.case.evidence.length > 0);
  check('employee report is employee-safe (no admin report / raw fields)', (() => {
    const v = JSON.stringify(toEmployeeView(works!.case));
    return !v.includes('adminReport') && !v.includes('@odata') && !v.includes(TOKEN) && !v.includes(SECRET);
  })());
  check('admin report contains structured detail', !!toAdminView(works!.case).adminReport && !!toAdminView(works!.case).tripleCheck);
  const adminQ = await casesGET(new Request('http://localhost/api/it-agent/cases', { headers: { 'x-watson-role': 'admin' } }));
  check('admin can view the case queue', adminQ.status === 200);
  const empQ = await casesGET(new Request('http://localhost/api/it-agent/cases', { headers: { 'x-watson-role': 'employee' } }));
  check('employee cannot access the admin queue', empQ.status === 403);
  check('queue has cases with preserved classification', listAllCases().length > 0);

  // ================================================================
  console.log('\n[48] Visual, voice & existing protections');
  // ================================================================
  check('particle state maps: investigating', caseStateToParticleState('investigating') === 'investigating');
  check('particle state maps: waiting_for_approval => waiting_for_permission', caseStateToParticleState('waiting_for_approval') === 'waiting_for_permission');
  check('particle state maps: listening/speaking flags win', caseStateToParticleState('investigating', { listening: true }) === 'listening' && caseStateToParticleState('resolved', { speaking: true }) === 'explaining');
  check('every particle state has a text label (not animation-only)', (['ready', 'listening', 'understanding', 'investigating', 'explaining', 'waiting_for_permission', 'working', 'verifying', 'resolved', 'escalated', 'unavailable'] as const).every((s) => typeof PARTICLE_LABELS[s] === 'string'));
  check('particle component renders with an aria label (a11y)', /aria-label="Watson status/.test(renderToStaticMarkup(<WatsonParticles state="ready" />)));
  const tts = createMockTextToSpeech();
  const flag = { ended: false };
  const handle = tts.speak('hello there', { onEnd: () => { flag.ended = true; } });
  check('mock TTS speaks + resolves without external calls (non-browser)', flag.ended && tts.speaking === false);
  handle.stop();
  check('interruption handle stops playback state', tts.speaking === false);
  check('mock voice profile is direction-only (British, no impersonation)', WATSON_VOICE.language === 'en-GB' && /no impersonation/i.test(WATSON_VOICE.notes));
  check('no audio persisted on the case (transcript only)', !('audio' in (works!.case as unknown as Record<string, unknown>)) && !JSON.stringify(toAdminView(works!.case)).includes('audioData'));

  check('mock M365 remains default / live disabled (general exec off)', isLiveExternalExecutionEnabled() === false);
  const dump = JSON.stringify(listAudit({ limit: 8000 }));
  check('case audit never contains token/secret sentinels', !dump.includes(TOKEN) && !dump.includes(SECRET));
  check('case lifecycle audit events written', listAudit({ action: 'case_created', limit: 50 }).length > 0 && listAudit({ action: 'diagnosis_proposed', limit: 50 }).length > 0 && listAudit({ action: 'case_resolved', limit: 50 }).length > 0);

  return { pass, fail, failures };
}
