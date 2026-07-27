// Pure, presentational rendering of one M365 diagnostic outcome. No hooks, no
// fetch, no state — safe to render on the server and to unit-test. It renders
// ONLY normalized fields and never raw Graph JSON, tokens, secrets, headers, or
// errors. Mock results are visibly labeled so they cannot be mistaken for
// tenant evidence. There are no write/remediation controls anywhere.
import type { M365DiagnosticOutcome, M365ReadKey } from '@/lib/it-agent';

export interface ReadinessView {
  authMode: 'demo' | 'entra';
  liveReadGateEnabled: boolean;
  connectorReadiness: 'mock' | 'ready_for_live' | 'fail_closed';
  reasonCodes: string[];
}

// Pure, value-free readiness banner. Shows only the auth mode, connector
// readiness state, and safe reason codes — never any configuration value.
export function ReadinessBanner({ readiness }: { readiness: ReadinessView }) {
  const r = readiness.connectorReadiness;
  const tone =
    r === 'ready_for_live' ? 'border-sky-300 bg-sky-50 text-sky-900'
    : r === 'fail_closed' ? 'border-amber-300 bg-amber-50 text-amber-900'
    : 'border-purple-200 bg-purple-50 text-purple-900';
  const label =
    r === 'ready_for_live' ? 'Live read-only is configured (gate + config present). Results below can be live.'
    : r === 'fail_closed' ? 'Live read requested but fail-closed — serving nothing live.'
    : 'Mock mode — diagnostics return simulated data, not tenant evidence.';
  return (
    <div className={`rounded-xl border p-3 text-sm ${tone}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-current/20 bg-white/70 px-2 py-0.5 text-xs font-semibold uppercase">auth: {readiness.authMode}</span>
        <span className="rounded-full border border-current/20 bg-white/70 px-2 py-0.5 text-xs font-semibold uppercase">connector: {r}</span>
        <span className="text-xs">gate {readiness.liveReadGateEnabled ? 'enabled' : 'disabled'}</span>
      </div>
      <p className="mt-1">{label}</p>
      {readiness.reasonCodes.length > 0 ? (
        <p className="mt-1 text-xs opacity-80">codes: {readiness.reasonCodes.map((c) => <code key={c} className="mr-1">{c}</code>)}</p>
      ) : null}
    </div>
  );
}

const READ_LABELS: Record<M365ReadKey, string> = {
  lookup_user: 'User Lookup',
  check_license_status: 'License Status',
  check_mfa_status: 'MFA Status',
  check_mailbox_status: 'Mailbox Status',
  check_group_membership: 'Group Membership'
};

function renderValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (Array.isArray(v)) return v.length ? v.map((x) => String(x)).join(', ') : '(none)';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

function StateBadge({ state }: { state: string }) {
  const tone =
    state === 'ok' ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
    : state === 'not_found' ? 'bg-slate-50 text-slate-700 border-slate-200'
    : 'bg-amber-50 text-amber-900 border-amber-200';
  return <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${tone}`}>{state}</span>;
}

export function DiagnosticsResultCard({ outcome }: { outcome: M365DiagnosticOutcome }) {
  const title = READ_LABELS[outcome.read] ?? outcome.read;

  if (outcome.outcome === 'denied') {
    return (
      <div className="rounded-xl border border-rose-200 bg-rose-50 p-4">
        <div className="flex items-center justify-between">
          <div className="font-semibold text-rose-900">{title}</div>
          <span className="rounded-full border border-rose-200 bg-white px-2 py-0.5 text-xs text-rose-800">denied</span>
        </div>
        <p className="mt-1 text-sm text-rose-800">Not authorized to run this diagnostic.</p>
      </div>
    );
  }

  if (outcome.outcome === 'not_configured') {
    return (
      <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
        <div className="flex items-center justify-between">
          <div className="font-semibold text-amber-900">{title}</div>
          <span className="rounded-full border border-amber-300 bg-white px-2 py-0.5 text-xs text-amber-900">not configured</span>
        </div>
        <p className="mt-1 text-sm text-amber-900">
          Live read is not available (fail-closed). Reason: <code>{outcome.reason}</code>
        </p>
      </div>
    );
  }

  // evidence
  const isMock = outcome.connector === 'mock' || outcome.result.source === 'mock';
  const data = outcome.result.data;
  const entries = data && typeof data === 'object' ? Object.entries(data as Record<string, unknown>) : [];

  return (
    <div className="rounded-xl border border-watson-line bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="font-semibold text-watson-ink">{title}</div>
        <div className="flex items-center gap-2">
          {isMock ? (
            <span className="rounded-full border border-purple-300 bg-purple-50 px-2 py-0.5 text-xs font-semibold text-purple-800">
              MOCK DATA — not tenant evidence
            </span>
          ) : (
            <span className="rounded-full border border-sky-300 bg-sky-50 px-2 py-0.5 text-xs font-semibold text-sky-800">
              LIVE (read-only)
            </span>
          )}
          <StateBadge state={outcome.result.state} />
        </div>
      </div>

      {entries.length > 0 ? (
        <dl className="mt-3 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
          {entries.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 border-b border-slate-100 py-1">
              <dt className="text-watson-mist">{k}</dt>
              <dd className="text-right font-medium text-watson-ink">{renderValue(v)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-2 text-sm text-watson-mist">No data returned for this read.</p>
      )}

      {outcome.result.note ? <p className="mt-2 text-xs text-watson-mist">{outcome.result.note}</p> : null}
    </div>
  );
}
