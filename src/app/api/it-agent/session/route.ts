import { NextResponse } from 'next/server';
import { actorFromRequest, demoIdentities } from '@/lib/it-agent/session';
import { operatingMode, isLiveExternalExecutionEnabled, SAFETY_BANNER } from '@/lib/it-agent/constants';
import { providerInfo } from '@/lib/it-agent/ai-provider';
import { ok } from '@/lib/http';

export async function GET(req: Request) {
  return ok({
    actor: actorFromRequest(req),
    identities: demoIdentities(),
    mode: operatingMode(),
    liveExecutionEnabled: isLiveExternalExecutionEnabled(),
    ai: providerInfo(),
    safety: SAFETY_BANNER
  });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { role?: string };
  const role = (body.role ?? 'employee').toLowerCase();
  const res = NextResponse.json({ ok: true, data: { role } });
  res.cookies.set('watson_role', role, { path: '/', httpOnly: false, sameSite: 'lax' });
  return res;
}
