'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { StatusBadge, PriorityBadge, CategoryBadge } from './Badges';
import { api, getCookieRole } from './api';
import { TICKET_STATUSES, TICKET_CATEGORIES, PRIORITIES } from '@/lib/it-agent/types';

interface Ticket { id: string; shortId: string; subject: string; status: string; priority: string; category: string; requesterName?: string; requesterEmail: string; createdAt: string; }

export function AdminTicketQueue() {
  const [rows, setRows] = useState<Ticket[]>([]);
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  const [priority, setPriority] = useState('');
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    const role = getCookieRole();
    if (role !== 'admin' && role !== 'owner') { setDenied(true); return; }
    const q = new URLSearchParams({ scope: 'all' });
    if (status) q.set('status', status);
    if (category) q.set('category', category);
    if (priority) q.set('priority', priority);
    api<Ticket[]>(`/api/it-agent/tickets?${q.toString()}`).then((r) => r.ok && setRows(r.data));
  }, [status, category, priority]);

  if (denied) return <p className="text-sm text-amber-800">Admin/Owner role required (backend enforced).</p>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-lg border border-watson-line px-2 py-2 text-xs">
          <option value="">All statuses</option>
          {TICKET_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="rounded-lg border border-watson-line px-2 py-2 text-xs">
          <option value="">All categories</option>
          {TICKET_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={priority} onChange={(e) => setPriority(e.target.value)} className="rounded-lg border border-watson-line px-2 py-2 text-xs">
          <option value="">All priorities</option>
          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <span className="self-center text-xs text-watson-mist">{rows.length} ticket(s)</span>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-watson-line bg-white shadow-sm">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-watson-bg text-left text-xs text-watson-mist">
            <tr>
              <th className="px-3 py-2">ID</th><th className="px-3 py-2">Subject</th><th className="px-3 py-2">Requester</th>
              <th className="px-3 py-2">Category</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Priority</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className="border-t border-watson-line hover:bg-watson-bg">
                <td className="px-3 py-2"><Link href={`/it/tickets/${t.id}`} className="font-semibold text-watson-accent">{t.shortId}</Link></td>
                <td className="px-3 py-2"><Link href={`/it/tickets/${t.id}`} className="hover:underline">{t.subject}</Link></td>
                <td className="px-3 py-2 text-xs text-watson-mist">{t.requesterName ?? t.requesterEmail}</td>
                <td className="px-3 py-2"><CategoryBadge category={t.category} /></td>
                <td className="px-3 py-2"><StatusBadge status={t.status} /></td>
                <td className="px-3 py-2"><PriorityBadge priority={t.priority} /></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-xs text-watson-mist">No tickets match.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
