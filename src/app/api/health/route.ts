// ============================================================
// Watson — deployment health / readiness probe.
// ------------------------------------------------------------
// Public, value-free health check for Azure App Service health probes. Returns
// 200 when the deployment is coherent, 503 when Entra-mode configuration is
// incomplete (fail-closed). It exposes ONLY safe booleans + reason codes —
// never tenant/client ids, secret refs, vault URLs, tokens, secrets, or claims.
// No Azure/Graph client is constructed and no external call is made.
// ============================================================
import { deploymentHealth } from '@/lib/it-agent/deployment';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const h = deploymentHealth(process.env);
  return NextResponse.json(
    {
      status: h.healthy ? 'ok' : 'misconfigured',
      authMode: h.authMode,
      liveReadGateEnabled: h.liveReadGateEnabled,
      liveExecutionEnabled: h.liveExecutionEnabled,
      reasonCodes: h.reasonCodes,
      // Build provenance (015). A staged pilot must be able to prove over HTTP
      // which commit is actually being served — without it a stale build is
      // indistinguishable from a fresh one. A public commit hash is not
      // sensitive; null when the deployment recorded none.
      commit: process.env.WATSON_DEPLOYED_SHA?.trim() || null,
      environment: process.env.WATSON_ENVIRONMENT?.trim() || 'unspecified'
    },
    { status: h.healthy ? 200 : 503, headers: { 'Cache-Control': 'no-store' } }
  );
}
