// ============================================================
// Watson — H&R AI IT Agent : Employee experience API
// ------------------------------------------------------------
// GET  — resume the employee's current open case (employee-safe view) or null.
// POST — one turn: { action, caseId?, text?, platform?, choice?, attachment? }.
//        Actions: start | message | approve | decline | run | stop | verify |
//                 attach | technician. All mock/read-only. The response is the
//        employee-safe case view — never raw evidence internals, secrets, or
//        admin data. getCaseForActor enforces own-case-only access.
// ============================================================
import { getServerActor } from '@/lib/it-agent/session';
import { ensureSeeded } from '@/lib/it-agent/knowledge';
import {
  startCase, addEmployeeMessage, decideCaseApproval, runSimulatedRepair,
  stopSimulatedRepair, submitVerification, attachScreenshot,
  getCaseForActor, currentOpenCase
} from '@/lib/it-agent';
import { toEmployeeView } from '@/lib/it-agent/watson/cases';
import { ok, fail } from '@/lib/http';
import type { Platform } from '@/lib/it-agent';

export const dynamic = 'force-dynamic';
const NO_STORE = { headers: { 'Cache-Control': 'no-store' } } as const;

const VALID_PLATFORMS: Platform[] = ['windows', 'macos', 'ios', 'ipados', 'unknown'];
function platformOf(v: unknown): Platform | undefined {
  return typeof v === 'string' && VALID_PLATFORMS.includes(v as Platform) ? (v as Platform) : undefined;
}

export async function GET(req: Request) {
  const actor = getServerActor(req);
  if (!actor) return fail('Authentication required.', 401);
  ensureSeeded();
  const c = currentOpenCase(actor);
  return ok(c ? toEmployeeView(c) : null, NO_STORE);
}

export async function POST(req: Request) {
  try {
    const actor = getServerActor(req);
    if (!actor) return fail('Authentication required.', 401);
    ensureSeeded();

    const body = (await req.json().catch(() => ({}))) as {
      action?: string; caseId?: string; text?: string; platform?: string;
      choice?: string; attachment?: { kind?: string; name?: string; contentType?: string; sizeBytes?: number; note?: string };
    };
    const action = String(body.action ?? '');

    if (action === 'start') {
      const text = String(body.text ?? '').trim();
      if (!text) return fail('Please describe the problem.', 400);
      if (text.length > 4000) return fail('Message is too long.', 400);
      const turn = await startCase(actor, text, { platform: platformOf(body.platform) });
      return ok(toEmployeeView(turn.case), NO_STORE);
    }

    // All other actions require an owned case id.
    const caseId = String(body.caseId ?? '');
    if (!caseId) return fail('caseId is required.', 400);
    if (!getCaseForActor(caseId, actor)) return fail('Case not found.', 404);

    if (action === 'message') {
      const text = String(body.text ?? '').trim();
      if (!text) return fail('Message is empty.', 400);
      if (text.length > 4000) return fail('Message is too long.', 400);
      const turn = await addEmployeeMessage(actor, caseId, text);
      return turn ? ok(toEmployeeView(turn.case), NO_STORE) : fail('Case not found.', 404);
    }
    if (action === 'technician') {
      const turn = await addEmployeeMessage(actor, caseId, 'I would like a technician please.');
      return turn ? ok(toEmployeeView(turn.case), NO_STORE) : fail('Case not found.', 404);
    }
    if (action === 'approve' || action === 'decline') {
      const turn = decideCaseApproval(actor, caseId, action === 'approve' ? 'approve' : 'decline');
      return turn ? ok(toEmployeeView(turn.case), NO_STORE) : fail('No pending approval on this case.', 409);
    }
    if (action === 'run') {
      const turn = runSimulatedRepair(actor, caseId);
      return turn ? ok(toEmployeeView(turn.case), NO_STORE) : fail('Nothing to run.', 409);
    }
    if (action === 'stop') {
      const turn = stopSimulatedRepair(actor, caseId);
      return turn ? ok(toEmployeeView(turn.case), NO_STORE) : fail('Nothing to stop.', 409);
    }
    if (action === 'verify') {
      const choice = String(body.choice ?? '');
      if (!['works', 'still_broken', 'partial', 'unsure'].includes(choice)) return fail('Invalid verification choice.', 400);
      const turn = submitVerification(actor, caseId, choice as 'works' | 'still_broken' | 'partial' | 'unsure');
      return turn ? ok(toEmployeeView(turn.case), NO_STORE) : fail('Case not found.', 404);
    }
    if (action === 'attach') {
      const a = body.attachment ?? {};
      const kind = a.kind === 'photo' ? 'photo' : 'screenshot';
      const name = String(a.name ?? 'attachment');
      const contentType = String(a.contentType ?? 'image/png');
      const sizeBytes = Number(a.sizeBytes ?? 0);
      if (!/^image\//.test(contentType)) return fail('Only image attachments are supported.', 400);
      if (!(sizeBytes >= 0 && sizeBytes <= 25_000_000)) return fail('Attachment is too large.', 400);
      const c = attachScreenshot(actor, caseId, { kind, name: name.slice(0, 200), contentType, sizeBytes, note: a.note ? String(a.note).slice(0, 200) : undefined });
      return c ? ok(toEmployeeView(c), NO_STORE) : fail('Case not found.', 404);
    }

    return fail('Unsupported action.', 400);
  } catch {
    return fail('Internal error handling the request.', 500);
  }
}
