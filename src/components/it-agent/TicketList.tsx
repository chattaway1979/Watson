'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { StatusBadge, PriorityBadge, CategoryBadge } from './Badges';
import { api } from './api';

interface Ticket { id: string; shortId: string; subject: string; category: string; status: string; priority: string; createdAt: string; requesterName?: string; }

export function TicketList({ scope = 'mine' }: { scope?: 'mine' | 'all' }) {
  const [rows, setRows] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<Ticket[]>(`/api/it-agent/tickets${scope === 'all' ? '?scope=all' : ''}`).then((r) => {
      if (r.ok) setRows(r.data); else setErr(r.error);
      setLoading(false);
    });
  }, [scope]);

  if (loading) return <p className="text-sm text-watson-mist">Loading tickets…</p>;
  if (err) return <p className="text-sm text-red-600">{err}</p>;
  if (rows.length === 0) return (
    <div className="rounded-xl border border-dashed border-watson-line bg-white p-6 text-center text-sm text-watson-mist">
      No tickets yet. <Link className="text-watson-accent underline" href="/it/help">Ask Watson for help →</Link>
    </div>
  );

  return (
    <div className="space-y-2">
      {rows.map((t) => (
        <Link key={t.id} href={`/it/tickets/${t.id}`} className="block rounded-xl border border-watson-line bg-white p-3 shadow-sm transition hover:border-watson-accent">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-watson-mist">{t.shortId}</span>
                <span className="truncate text-sm font-medium text-watson-ink">{t.subject}</span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <CategoryBadge category={t.category} />
                <StatusBadge status={t.status} />
                <PriorityBadge priority={t.priority} />
              </div>
            </div>
            <span className="text-[11px] text-watson-mist">{new Date(t.createdAt).toLocaleString()}</span>
          </div>
        </Link>
      ))}
    </div>
  );
}
