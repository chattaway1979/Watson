'use client';
import { useEffect, useState } from 'react';
import { api, getCookieRole } from './api';
import { AUDIT_EVENTS } from '@/lib/it-agent/types';

interface Audit { id: string; actorType: string; actorId: string; action: string; targetType: string; targetId: string; metadata?: Record<string, unknown> | null; createdAt: string; }

const ACTION_COLOR: Record<string, string> = {
  approval_requested: 'bg-purple-100 text-purple-800',
  approval_approved: 'bg-emerald-100 text-emerald-800',
  approval_rejected: 'bg-red-100 text-red-800',
  mock_action_executed: 'bg-blue-100 text-blue-800',
  policy_decision_recorded: 'bg-slate-100 text-slate-700',
  connector_mock_called: 'bg-sky-100 text-sky-800'
};

export function AuditTimeline() {
  const [rows, setRows] = useState<Audit[]>([]);
  const [denied, setDenied] = useState(false);
  const [action, setAction] = useState('');

  useEffect(() => {
    const role = getCookieRole();
    if (role !== 'admin' && role !== 'owner') { setDenied(true); return; }
    const q = action ? `?action=${action}&limit=300` : '?limit=300';
    api<Audit[]>(`/api/it-agent/audit${q}`).then((r) => r.ok && setRows(r.data));
  }, [action]);

  if (denied) return <p className="text-sm text-amber-800">Admin/Owner role required (backend enforced).</p>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select value={action} onChange={(e) => setAction(e.target.value)} className="rounded-lg border border-watson-line px-2 py-2 text-xs">
          <option value="">All event types</option>
          {AUDIT_EVENTS.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <span className="text-xs text-watson-mist">{rows.length} event(s)</span>
      </div>
      <div className="rounded-2xl border border-watson-line bg-white shadow-sm">
        <ol>
          {rows.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-2 border-b border-watson-line px-3 py-2 text-xs last:border-0">
              <span className={`rounded px-1.5 py-0.5 font-medium ${ACTION_COLOR[e.action] ?? 'bg-slate-100 text-slate-700'}`}>{e.action}</span>
              <span className="text-watson-mist">{e.actorType}:{e.actorId}</span>
              <span className="text-watson-steel">→ {e.targetType}/{e.targetId}</span>
              <span className="ml-auto text-[10px] text-watson-mist">{new Date(e.createdAt).toLocaleString()}</span>
              {e.metadata && Object.keys(e.metadata).length > 0 && (
                <details className="w-full">
                  <summary className="cursor-pointer text-watson-accent">metadata</summary>
                  <pre className="mt-1 overflow-x-auto rounded bg-slate-50 p-2 text-[10px]">{JSON.stringify(e.metadata, null, 2)}</pre>
                </details>
              )}
            </li>
          ))}
          {rows.length === 0 && <li className="px-3 py-6 text-center text-xs text-watson-mist">No audit events.</li>}
        </ol>
      </div>
    </div>
  );
}
