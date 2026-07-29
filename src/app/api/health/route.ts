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
import { rbacStoreProvenance, rbacStore } from '@/lib/it-agent/rbac/store-provider';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// 021G-3: prove over HTTP which RBAC store a worker is ACTUALLY using and whether
// it can reach it. Without this, "staging is on PostgreSQL" is a claim about
// configuration rather than an observed fact, and a worker that silently failed
// to connect would be indistinguishable from a healthy one.
//
// This probe reports the condition; it deliberately does NOT flip the overall
// status. `status` is what the deploy guard polls to decide a rollout is live, and
// a transient database blip must not be reported as a bad deployment. Fail-closed
// behaviour lives where it belongs — the RBAC entry point refuses, it does not
// guess — and the reason code below makes the condition visible either way.
async function storeHealth(): Promise<{
  store: string; multiInstanceSafe: boolean; reachable: boolean | null; reasonCodes: string[];
}> {
  const prov = rbacStoreProvenance(process.env);
  if (prov.store === 'invalid') {
    return { store: 'invalid', multiInstanceSafe: false, reachable: null, reasonCodes: ['rbac_store_unknown'] };
  }
  // Bounded: a health probe must never hang on a database that is not answering.
  let reachable: boolean | null = null;
  try {
    reachable = await Promise.race([
      rbacStore(process.env).ping(),
      new Promise<boolean>((r) => setTimeout(() => r(false), 4_000))
    ]);
  } catch {
    // A misconfigured store throws on construction. That is a real condition and
    // is reported as unreachable rather than swallowed.
    reachable = false;
  }
  return {
    store: prov.store, multiInstanceSafe: prov.multiInstanceSafe, reachable,
    reasonCodes: reachable === false ? ['rbac_store_unreachable'] : []
  };
}

export async function GET() {
  const h = deploymentHealth(process.env);
  const s = await storeHealth();
  return NextResponse.json(
    {
      status: h.healthy ? 'ok' : 'misconfigured',
      authMode: h.authMode,
      liveReadGateEnabled: h.liveReadGateEnabled,
      liveExecutionEnabled: h.liveExecutionEnabled,
      reasonCodes: [...h.reasonCodes, ...s.reasonCodes],
      // RBAC persistence provenance. TYPE and reachability only — never a host,
      // database name, user, port or connection string.
      rbacStore: s.store,
      rbacStoreMultiInstanceSafe: s.multiInstanceSafe,
      rbacStoreReachable: s.reachable,
      // Which worker answered. Two workers must be observably distinguishable, or
      // "the cluster agrees" cannot be verified from outside.
      workerId: process.env.WEBSITE_INSTANCE_ID?.slice(0, 12) ?? null,
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
