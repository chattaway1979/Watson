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
import { packageProvenance } from '@/lib/it-agent/build-provenance';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Bounded but generous enough that a normal cold connection is not reported as a
// failure. Total worst case is the sum of the two, which stays well inside the
// platform request timeout.
const COLD_PROBE_BUDGET_MS = 15_000;
const WARM_PROBE_BUDGET_MS = 10_000;

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
  store: string; multiInstanceSafe: boolean; reachable: boolean | null;
  phase: string | null; category: string | null; cause: string | null; reasonCodes: string[];
}> {
  const prov = rbacStoreProvenance(process.env);
  if (prov.store === 'invalid') {
    return { store: 'invalid', multiInstanceSafe: false, reachable: null,
      phase: 'config', category: 'store_unavailable', cause: 'configuration_invalid', reasonCodes: ['rbac_store_unknown'] };
  }
  // Bounded: a health probe must never hang on a database that is not answering.
  let reachable: boolean | null = null;
  let phase: string | null = null;
  let category: string | null = null;
  let cause: string | null = null;
  try {
    const store = rbacStore(process.env);
    // A yes/no answer tells an operator nothing actionable: "unreachable" and
    // "the identity has no rights on a table" need different fixes. Where the
    // adapter can say WHICH stage failed, report that — phase and classified
    // category only, never a driver message.
    const probe = (store as { probe?: () => Promise<{ ok: boolean; phase: string; category: string; cause?: string }> }).probe;
    // COLD START. The first probe after a restart pays for TLS, an Entra token
    // fetch and a fresh connection, which legitimately exceeded the old 8s
    // budget and made a healthy worker report itself unreachable. A false
    // unhealthy result is not harmless: it trains operators to ignore the
    // signal. So the budget is larger AND a timed-out first attempt is retried
    // once with a warm pool, which is the attempt that reflects steady state.
    // It stays bounded — two attempts, hard-capped — so health can never hang.
    const attempt = (budgetMs: number) => Promise.race([
      probe ? probe.call(store) : store.ping().then((ok) => ({
        ok, phase: 'none', category: ok ? 'ok' : 'store_unavailable',
        cause: ok ? undefined : 'unknown' as string | undefined
      })),
      new Promise<{ ok: boolean; phase: string; category: string; cause?: string }>((r) =>
        setTimeout(() => r({ ok: false, phase: 'connect', category: 'store_unavailable', cause: 'probe_timeout' }), budgetMs))
    ]);
    let result = await attempt(COLD_PROBE_BUDGET_MS);
    if (!result.ok && result.cause === 'probe_timeout') {
      result = await attempt(WARM_PROBE_BUDGET_MS);
      // Distinguishable from a first-attempt timeout, so a genuinely slow store
      // is not silently reported the same way as a cold start.
      if (!result.ok && result.cause === 'probe_timeout') result = { ...result, cause: 'probe_timeout_after_retry' };
    }
    reachable = result.ok;
    if (!result.ok) { phase = result.phase; category = result.category; cause = result.cause ?? null; }
  } catch {
    // A misconfigured store throws on construction. That is a real condition and
    // is reported rather than swallowed.
    reachable = false; phase = 'config'; category = 'store_unavailable'; cause = 'configuration_invalid';
  }
  return {
    store: prov.store, multiInstanceSafe: prov.multiInstanceSafe, reachable, phase, category, cause,
    reasonCodes: reachable === false ? ['rbac_store_unreachable'] : []
  };
}

export async function GET() {
  const h = deploymentHealth(process.env);
  const s = await storeHealth();
  const prov = packageProvenance();
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
      // Only populated on failure. A stage name and a safe contract category —
      // enough to know what to fix, with nothing an attacker could use.
      rbacStoreFailurePhase: s.phase,
      rbacStoreFailureCategory: s.category,
      rbacStoreFailureCause: s.cause,
      // Which worker answered. Two workers must be observably distinguishable, or
      // "the cluster agrees" cannot be verified from outside.
      workerId: process.env.WEBSITE_INSTANCE_ID?.slice(0, 12) ?? null,
      // Build provenance (015). A staged pilot must be able to prove over HTTP
      // which commit is actually being served — without it a stale build is
      // indistinguishable from a fresh one. A public commit hash is not
      // sensitive; null when the deployment recorded none.
      commit: process.env.WATSON_DEPLOYED_SHA?.trim() || null,
      // 021G-3: `commit` above is an APP SETTING and is therefore mutable from
      // outside the artefact — the deploy guard writes it before it restarts, so
      // it cannot be evidence about which bundle is running. The two fields
      // below come from inside the package and change only when the package
      // does, which is what makes a stale mount detectable.
      packageCommit: prov.packageSha,
      packageBuildId: prov.packageBuildId,
      packageBuiltAt: prov.builtAt,
      environment: process.env.WATSON_ENVIRONMENT?.trim() || 'unspecified'
    },
    { status: h.healthy ? 200 : 503, headers: { 'Cache-Control': 'no-store' } }
  );
}
