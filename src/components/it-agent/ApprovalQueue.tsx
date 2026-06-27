'use client';
import { useCallback, useEffect, useState } from 'react';
import { RiskBadge } from './Badges';
import { api, getCookieRole } from './api';

interface Approval {
  id: string; shortId: string; actionKey: string; actionDisplayName: string; riskLevel: string; status: string;
  ticketId?: string | null; requestedByName?: string; targetId: string; payload: Record<string, unknown>;
  mockExecuted: boolean; decisionNote?: string; createdAt: string;
}

export function ApprovalQueue() {
  const [rows, setRows] = useState<Approval[]>([]);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [filter, setFilter] = useState('pending');

  const load = useCallback(() => {
    const role = getCookieRole();
    if (role !== 'admin' && role !== 'owner') { setDenied(true); return; }
    const q = filter ? `?status=${filter}` : '';
    api<Approval[]>(`/api/it-agent/approvals${q}`).then((r) => r.ok && setRows(r.data));
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  async function decide(id: string, decision: 'approved' | 'rejected') {
    setBusy(id); setMsg(null);
    const r = await api<{ message: string }>(`/api/it-agent/approvals/${id}`, { method: 'POST', body: JSON.stringify({ decision, note: `${decision} via approval queue` }) });
    setMsg(r.ok ? r.data.message : r.error);
    setBusy(null);
    load();
  }

  if (denied) return <p className="text-sm text-amber-800">Admin/Owner role required to view the approval queue (backend enforced).</p>;

  return (
    <div className="space-y-3">
      {msg && <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">{msg}</div>}
      <div className="flex gap-2">
        {['pending', 'approved', 'rejected', ''].map((f) => (
          <button key={f || 'all'} onClick={() => setFilter(f)} className={`rounded-lg px-3 py-1.5 text-xs ${filter === f ? 'bg-watson-ink text-white' : 'border border-watson-line bg-white'}`}>{f || 'all'}</button>
        ))}
      </div>
      {rows.length === 0 && <p className="rounded-xl border border-dashed border-watson-line bg-white p-6 text-center text-sm text-watson-mist">No {filter || ''} approval requests.</p>}
      {rows.map((a) => (
        <div key={a.id} className="rounded-2xl border border-watson-line bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-watson-mist">{a.shortId}</span>
            <RiskBadge risk={a.riskLevel} />
            <span className="text-sm font-medium text-watson-ink">{a.actionDisplayName}</span>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase text-slate-600">{a.status}</span>
            {a.mockExecuted && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700">mock-executed</span>}
          </div>
          <div className="mt-2 grid gap-1 text-xs text-watson-mist sm:grid-cols-2">
            <div>Action key: <span className="font-mono text-watson-steel">{a.actionKey}</span></div>
            <div>Target: <span className="text-watson-steel">{a.targetId}</span></div>
            <div>Requested by: {a.requestedByName ?? '—'}</div>
            <div>{new Date(a.createdAt).toLocaleString()}</div>
          </div>
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer text-watson-accent">View proposed payload</summary>
            <pre className="mt-1 overflow-x-auto rounded bg-slate-50 p-2 text-[11px]">{JSON.stringify(a.payload, null, 2)}</pre>
          </details>
          {a.status === 'pending' && (
            <div className="mt-3 flex gap-2">
              <button onClick={() => decide(a.id, 'approved')} disabled={busy === a.id} className="btn rounded-lg bg-emerald-600 px-4 py-2 text-xs font-medium text-white disabled:opacity-50">Approve</button>
              <button onClick={() => decide(a.id, 'rejected')} disabled={busy === a.id} className="btn rounded-lg bg-red-600 px-4 py-2 text-xs font-medium text-white disabled:opacity-50">Reject</button>
              {a.riskLevel === 'critical' && <span className="self-center text-[11px] text-red-700">Critical — owner approval; live execution disabled.</span>}
            </div>
          )}
          {a.decisionNote && <p className="mt-2 text-[11px] text-watson-mist">Decision note: {a.decisionNote}</p>}
        </div>
      ))}
    </div>
  );
}
