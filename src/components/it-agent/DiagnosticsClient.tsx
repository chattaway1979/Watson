'use client';
import { useEffect, useState } from 'react';
import { api } from './api';
import { MockModeBanner } from './MockModeBanner';
import { DiagnosticsResultCard, ReadinessBanner, type ReadinessView } from './DiagnosticsResultCard';
import type { M365DiagnosticOutcome, M365ReadKey } from '@/lib/it-agent';

const READS: { key: M365ReadKey; label: string }[] = [
  { key: 'lookup_user', label: 'User Lookup' },
  { key: 'check_license_status', label: 'License Status' },
  { key: 'check_mfa_status', label: 'MFA Status' },
  { key: 'check_mailbox_status', label: 'Mailbox Status' },
  { key: 'check_group_membership', label: 'Group Membership' }
];

// Read-only administrator diagnostics console. It only calls the existing
// admin-only diagnostics + readiness APIs (which are authoritative). There are
// no write, remediation, or approval controls anywhere on this page.
export function DiagnosticsClient() {
  const [readiness, setReadiness] = useState<ReadinessView | null>(null);
  const [denied, setDenied] = useState(false);
  const [email, setEmail] = useState('');
  const [selected, setSelected] = useState<Set<M365ReadKey>>(new Set(['lookup_user']));
  const [results, setResults] = useState<M365DiagnosticOutcome[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<ReadinessView>('/api/it-agent/diagnostics/m365/readiness').then((r) => {
      if (r.ok) setReadiness(r.data);
      else setDenied(true);
    });
  }, []);

  function toggle(k: M365ReadKey) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }

  async function run() {
    setError(null);
    const target = email.trim();
    if (!target) { setError('Enter a user email / UPN.'); return; }
    const reads = selected.size ? [...selected] : READS.map((r) => r.key);
    setBusy(true);
    try {
      const out: M365DiagnosticOutcome[] = [];
      for (const read of reads) {
        const q = `/api/it-agent/diagnostics/m365?read=${encodeURIComponent(read)}&target=${encodeURIComponent(target)}`;
        const r = await api<M365DiagnosticOutcome>(q);
        if (r.ok) out.push(r.data);
        else if ((r as { status?: number }).status === 403 || /admin/i.test(r.error)) { setDenied(true); break; }
        else setError(r.error || 'Diagnostic failed.');
      }
      setResults(out);
    } catch {
      setError('Unexpected error running diagnostics.');
    } finally {
      setBusy(false);
    }
  }

  if (denied) {
    return (
      <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
        This console requires an <b>administrator</b>. Access is enforced by the backend.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <MockModeBanner />
      {readiness ? <ReadinessBanner readiness={readiness} /> : null}

      <div className="rounded-2xl border border-watson-line bg-white p-4">
        <label className="block text-sm font-medium text-watson-ink" htmlFor="diag-email">User email / UPN</label>
        <input
          id="diag-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="user@hrelectriccompany.com"
          className="mt-1 w-full rounded-lg border border-watson-line px-3 py-2 text-sm"
        />
        <div className="mt-3 flex flex-wrap gap-3">
          {READS.map((r) => (
            <label key={r.key} className="flex items-center gap-1.5 text-sm text-watson-ink">
              <input type="checkbox" checked={selected.has(r.key)} onChange={() => toggle(r.key)} />
              {r.label}
            </label>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={run}
            disabled={busy}
            className="rounded-lg bg-watson-ink px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? 'Running…' : 'Run read-only diagnostics'}
          </button>
          <button
            onClick={() => setSelected(new Set(READS.map((r) => r.key)))}
            className="text-sm text-watson-mist underline"
          >
            Select all five
          </button>
        </div>
        {error ? <p className="mt-2 text-sm text-rose-700">{error}</p> : null}
      </div>

      <div className="space-y-3">
        {results.map((o, i) => <DiagnosticsResultCard key={o.read + i} outcome={o} />)}
      </div>
    </div>
  );
}
