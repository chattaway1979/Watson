'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { StatusBadge, PriorityBadge, CategoryBadge, RiskBadge } from './Badges';
import { api, getCookieRole } from './api';

interface Ticket {
  id: string; shortId: string; subject: string; description: string; category: string; status: string; priority: string;
  requesterName?: string; requesterEmail: string; assigneeName?: string | null;
  aiDiagnosis?: { summary: string; likelyCauses: string[]; provider: string } | null;
  recommendedActions: { actionKey: string; displayName: string; riskLevel: string; requiresApproval: boolean; rationale: string }[];
  linkedApprovalIds: string[]; createdAt: string; updatedAt: string;
}
interface Message { id: string; authorName?: string; authorType: string; body: string; internal: boolean; createdAt: string; }
interface Event { id: string; type: string; summary: string; actorType: string; createdAt: string; }
interface Approval { id: string; shortId: string; actionDisplayName: string; riskLevel: string; status: string; }
interface Detail { ticket: Ticket; messages: Message[]; events: Event[]; approvals: Approval[]; }

const ADMIN_STATUSES = ['triaged', 'in_progress', 'waiting_on_employee', 'waiting_on_admin', 'resolved', 'closed', 'cancelled'];

export function TicketDetail({ id }: { id: string }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [role, setRole] = useState('employee');

  const load = useCallback(async () => {
    const r = await api<Detail>(`/api/it-agent/tickets/${id}`);
    if (r.ok) setD(r.data); else setErr(r.error);
  }, [id]);

  useEffect(() => { setRole(getCookieRole()); load(); }, [load]);

  const isAdmin = role === 'admin' || role === 'owner';

  async function postMessage() {
    if (!msg.trim()) return;
    setBusy(true);
    const r = await api(`/api/it-agent/tickets/${id}/messages`, { method: 'POST', body: JSON.stringify({ body: msg, internal }) });
    if (r.ok) { setMsg(''); await load(); }
    setBusy(false);
  }
  async function patch(op: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    const r = await api(`/api/it-agent/tickets/${id}`, { method: 'PATCH', body: JSON.stringify({ op, ...extra }) });
    if (!r.ok) setErr(r.error);
    await load();
    setBusy(false);
  }

  if (err) return <p className="text-sm text-red-600">{err}</p>;
  if (!d) return <p className="text-sm text-watson-mist">Loading…</p>;
  const t = d.ticket;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
      <div className="space-y-4">
        <div className="rounded-2xl border border-watson-line bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-watson-mist">{t.shortId}</span>
            <CategoryBadge category={t.category} />
            <StatusBadge status={t.status} />
            <PriorityBadge priority={t.priority} />
          </div>
          <h2 className="mt-2 text-lg font-semibold text-watson-ink">{t.subject}</h2>
          <p className="mt-1 whitespace-pre-wrap text-sm text-watson-steel">{t.description}</p>
          <p className="mt-2 text-[11px] text-watson-mist">From {t.requesterName ?? t.requesterEmail} · opened {new Date(t.createdAt).toLocaleString()}</p>
        </div>

        {t.aiDiagnosis && (
          <div className="rounded-2xl border border-watson-line bg-white p-4 shadow-sm">
            <h3 className="mb-1 text-sm font-semibold text-watson-ink">Watson AI Diagnosis</h3>
            <p className="text-sm text-watson-steel">{t.aiDiagnosis.summary}</p>
            {t.aiDiagnosis.likelyCauses?.length > 0 && (
              <ul className="mt-2 list-inside list-disc text-xs text-watson-mist">
                {t.aiDiagnosis.likelyCauses.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            )}
            <p className="mt-2 text-[11px] text-watson-mist">Provider: {t.aiDiagnosis.provider}</p>
          </div>
        )}

        {t.recommendedActions.length > 0 && (
          <div className="rounded-2xl border border-watson-line bg-white p-4 shadow-sm">
            <h3 className="mb-2 text-sm font-semibold text-watson-ink">Recommended Actions</h3>
            <ul className="space-y-1.5">
              {t.recommendedActions.map((a) => (
                <li key={a.actionKey} className="flex flex-wrap items-center gap-1.5 text-xs">
                  <RiskBadge risk={a.riskLevel} />
                  <span className="font-medium">{a.displayName}</span>
                  {a.requiresApproval && <span className="rounded bg-purple-100 px-1.5 py-0.5 text-[10px] text-purple-700">approval required</span>}
                  <span className="text-watson-mist">— {a.rationale}</span>
                </li>
              ))}
            </ul>
            {isAdmin && <p className="mt-2 text-[11px] text-watson-mist">Run actions from the <Link className="underline" href="/it/admin/actions">Action Registry</Link>; high-risk actions create approval requests.</p>}
          </div>
        )}

        {d.approvals.length > 0 && (
          <div className="rounded-2xl border border-watson-line bg-white p-4 shadow-sm">
            <h3 className="mb-2 text-sm font-semibold text-watson-ink">Linked Approvals</h3>
            <ul className="space-y-1 text-xs">
              {d.approvals.map((a) => (
                <li key={a.id} className="flex items-center gap-2">
                  <span className="font-semibold text-watson-mist">{a.shortId}</span>
                  <RiskBadge risk={a.riskLevel} />
                  <span>{a.actionDisplayName}</span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px]">{a.status}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Conversation */}
        <div className="rounded-2xl border border-watson-line bg-white p-4 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold text-watson-ink">Conversation</h3>
          <div className="space-y-2">
            {d.messages.length === 0 && <p className="text-xs text-watson-mist">No messages yet.</p>}
            {d.messages.map((m) => (
              <div key={m.id} className={`rounded-lg border p-2 text-sm ${m.internal ? 'border-amber-200 bg-amber-50' : 'border-watson-line bg-watson-bg'}`}>
                <div className="mb-0.5 flex items-center gap-2 text-[11px] text-watson-mist">
                  <span className="font-medium text-watson-steel">{m.authorName ?? m.authorType}</span>
                  {m.internal && <span className="rounded bg-amber-200 px-1 text-[10px] text-amber-800">internal note</span>}
                  <span>{new Date(m.createdAt).toLocaleString()}</span>
                </div>
                <p className="whitespace-pre-wrap text-watson-ink">{m.body}</p>
              </div>
            ))}
          </div>
          <div className="mt-3 space-y-2">
            <textarea value={msg} onChange={(e) => setMsg(e.target.value)} rows={2} placeholder="Add a reply…" className="w-full rounded-lg border border-watson-line px-3 py-2 text-sm focus:border-watson-accent focus:outline-none" />
            <div className="flex flex-wrap items-center gap-2">
              {isAdmin && (
                <label className="flex items-center gap-1 text-xs text-watson-steel">
                  <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> internal note
                </label>
              )}
              <button onClick={postMessage} disabled={busy || !msg.trim()} className="btn rounded-lg bg-watson-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Send</button>
            </div>
          </div>
        </div>
      </div>

      {/* Side controls */}
      <aside className="space-y-3">
        <div className="rounded-2xl border border-watson-line bg-white p-4 text-sm shadow-sm">
          <h3 className="mb-2 font-semibold text-watson-ink">Lifecycle</h3>
          <div className="space-y-2">
            <button onClick={() => patch('escalate', { reason: 'Escalated from ticket view' })} disabled={busy} className="btn w-full rounded-lg border border-orange-300 bg-orange-50 px-3 py-2 text-xs font-medium text-orange-800">Escalate to admin</button>
            {(t.status === 'resolved' || t.status === 'closed') && (
              <button onClick={() => patch('status', { status: 'in_progress', note: 'Reopened' })} disabled={busy} className="btn w-full rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-800">Reopen ticket</button>
            )}
            {isAdmin && (
              <>
                <label className="block text-[11px] font-medium text-watson-mist">Set status</label>
                <select onChange={(e) => e.target.value && patch('status', { status: e.target.value })} value="" className="w-full rounded-lg border border-watson-line px-2 py-2 text-xs">
                  <option value="">Change status…</option>
                  {ADMIN_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <button onClick={() => patch('assign', { assigneeName: 'Watson Admin' })} disabled={busy} className="btn w-full rounded-lg border border-watson-line px-3 py-2 text-xs">Assign to me</button>
                <label className="block text-[11px] font-medium text-watson-mist">Set priority</label>
                <select onChange={(e) => e.target.value && patch('priority', { priority: e.target.value })} value="" className="w-full rounded-lg border border-watson-line px-2 py-2 text-xs">
                  <option value="">Change priority…</option>
                  {['low', 'normal', 'high', 'urgent'].map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </>
            )}
          </div>
          {t.assigneeName && <p className="mt-3 text-[11px] text-watson-mist">Assigned: {t.assigneeName}</p>}
        </div>

        <div className="rounded-2xl border border-watson-line bg-white p-4 text-sm shadow-sm">
          <h3 className="mb-2 font-semibold text-watson-ink">History</h3>
          <ol className="space-y-2">
            {d.events.map((e) => (
              <li key={e.id} className="border-l-2 border-watson-line pl-3 text-xs">
                <div className="font-medium text-watson-steel">{e.type}</div>
                <div className="text-watson-mist">{e.summary}</div>
                <div className="text-[10px] text-watson-mist">{new Date(e.createdAt).toLocaleString()}</div>
              </li>
            ))}
          </ol>
        </div>
      </aside>
    </div>
  );
}
