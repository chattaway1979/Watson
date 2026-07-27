import { NextResponse } from 'next/server';
import { actorFromRequest, demoIdentities, watsonAuthMode } from '@/lib/it-agent/session';
import { operatingMode, isLiveExternalExecutionEnabled, SAFETY_BANNER } from '@/lib/it-agent/constants';
import { providerInfo } from '@/lib/it-agent/ai-provider';
import { ok, fail } from '@/lib/http';

export async function GET(req: Request) {
  return ok({
    authMode: watsonAuthMode(),
    actor: actorFromRequest(req),
    identities: demoIdentities(), // [] in entra mode — no role switcher
    mode: operatingMode(),
    liveExecutionEnabled: isLiveExternalExecutionEnabled(),
    ai: providerInfo(),
    safety: SAFETY_BANNER
  });
}

export async function POST(req: Request) {
  // The demo role switcher is disabled in entra mode: identity comes only from
  // the verified Entra session, never from a client-set cookie.
  if (watsonAuthMode() === 'entra') {
    return fail('Role switching is disabled in Entra authentication mode.', 403);
  }
  const body = (await req.json().catch(() => ({}))) as { role?: string };
  const role = (body.role ?? 'employee').toLowerCase();
  const res = NextResponse.json({ ok: true, data: { role } });
  res.cookies.set('watson_role', role, { path: '/', httpOnly: false, sameSite: 'lax' });
  return res;
}
