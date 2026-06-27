'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { MockModeBanner } from './MockModeBanner';
import { StatusBadge, PriorityBadge } from './Badges';
import { api, getCookieRole } from './api';

interface Ticket { id: string; shortId: string; subject: string; status: string; priority: string; category: string; createdAt: string; }
interface Approval { id: string; status: string; riskLevel: string; }
interface Connectors { mode: string; liveExecutionEnabled: boolean; connectors: { label: string; mode: string; healthy: boolean; note: string }[]; }

export function AdminDashboard() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [conn, setConn] = useState<Connectors | null>(null);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    const role = getCookieRole();
    if (role !== 'admin' && role !== 'owner') { setDenied(true); return; }
    api<Ticket[]>('/api/it-agent/tickets?scope=all').then((r) => r.ok && setTickets(r.data));
    api<Approval[]>('/api/it-agent/approvals').then((r) => r.ok && setApprovals(r.data));
    api<Connectors>('/api/it-agent/connectors').then((r) => r.ok && setConn(r.data));
  }, []);

  if (denied) return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
      The admin dashboard requires the <b>Admin</b> or <b>Owner</b> role. Use the role switcher (top right) to view it. This is enforced by the backend, not just the UI.
    </div>
  );

  const open = tickets.filter((t) => !['closed', 'resolved', 'cancelled'].includes(t.status));
  const pending = approvals.filter((a) => a.status === 'pending');
  const stat = (label: string, value: number | string, href?: string, accent = false) => (
    <Link href={href ?? '#'} className={`rounded-2xl border p-4 shadow-sm ${accent ? 'border-purple-200 bg-purple-50' : 'border-watson-line bg-white'}`}>
      <div className="text-2xl font-semibold text-watson-ink">{value}</div>
      <div className="text-xs text-watson-mist">{label}</div>
    </Link>
  );

  return (
    <div className="space-y-4">
      <MockModeBanner mode={conn?.mode} live={conn?.liveExecutionEnabled} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stat('Open tickets', open.length, '/it/admin/tickets')}
        {stat('Total tickets', tickets.length, '/it/admin/tickets')}
        {stat('Pending approvals', pending.length, '/it/admin/approvals', pending.length > 0)}
        {stat('Connectors', conn?.connectors.length ?? 0, '/it/admin/actions')}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-watson-line bg-white p-4 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-watson-ink">Recent tickets</h3>
            <Link href="/it/admin/tickets" className="text-xs text-watson-accent underline">View queue</Link>
          </div>
          <div className="space-y-2">
            {tickets.slice(0, 6).map((t) => (
              <Link key={t.id} href={`/it/tickets/${t.id}`} className="flex items-center justify-between gap-2 rounded-lg border border-watson-line p-2 text-sm hover:border-watson-accent">
                <span className="truncate"><span className="text-xs font-semibold text-watson-mist">{t.shortId}</span> {t.subject}</span>
                <span className="flex shrink-0 gap-1"><StatusBadge status={t.status} /><PriorityBadge priority={t.priority} /></span>
              </Link>
            ))}
            {tickets.length === 0 && <p className="text-xs text-watson-mist">No tickets yet.</p>}
          </div>
        </div>

        <div className="rounded-2xl border border-watson-line bg-white p-4 shadow-sm">
          <h3 className="mb-2 text-sm font-semibold text-watson-ink">Connector status</h3>
          <div className="space-y-2">
            {conn?.connectors.map((c) => (
              <div key={c.label} className="flex items-start gap-2 rounded-lg border border-watson-line p-2 text-xs">
                <span className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${c.healthy ? 'bg-emerald-500' : 'bg-red-500'}`} />
                <div>
                  <div className="font-medium text-watson-ink">{c.label} <span className="rounded bg-slate-100 px-1 text-[10px] uppercase">{c.mode}</span></div>
                  <div className="text-watson-mist">{c.note}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <Link href="/it/admin/approvals" className="rounded-lg bg-watson-ink px-3 py-2 font-medium text-white">Approval queue</Link>
            <Link href="/it/admin/audit" className="rounded-lg border border-watson-line px-3 py-2">Audit log</Link>
            <Link href="/it/admin/knowledge" className="rounded-lg border border-watson-line px-3 py-2">Knowledge</Link>
            <Link href="/it/admin/actions" className="rounded-lg border border-watson-line px-3 py-2">Action registry</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
