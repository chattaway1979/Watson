'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CategoryBadge } from './Badges';
import { api } from './api';

interface Article { slug: string; title: string; category: string; summary: string; visibility: string; tags: string[]; }

export function KnowledgeAdmin() {
  const [rows, setRows] = useState<Article[]>([]);
  const [q, setQ] = useState('');

  function load(query = '') {
    api<Article[]>(`/api/it-agent/knowledge${query ? `?q=${encodeURIComponent(query)}` : ''}`).then((r) => r.ok && setRows(r.data));
  }
  useEffect(() => { load(); }, []);

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input value={q} onChange={(e) => { setQ(e.target.value); load(e.target.value); }} placeholder="Search articles…" className="flex-1 rounded-lg border border-watson-line px-3 py-2 text-sm" />
        <span className="self-center text-xs text-watson-mist">{rows.length} article(s)</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {rows.map((a) => (
          <Link key={a.slug} href={`/it/knowledge/${a.slug}`} className="rounded-2xl border border-watson-line bg-white p-3 shadow-sm hover:border-watson-accent">
            <div className="mb-1 flex items-center gap-2">
              <CategoryBadge category={a.category} />
              {a.visibility === 'internal' && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800">internal</span>}
            </div>
            <div className="text-sm font-medium text-watson-ink">{a.title}</div>
            <div className="text-xs text-watson-mist">{a.summary}</div>
          </Link>
        ))}
      </div>
      <p className="text-[11px] text-watson-mist">Article creation is available via <span className="font-mono">POST /api/it-agent/knowledge</span> (admin role). Internal articles are visible to admins only and are excluded from employee search by the backend.</p>
    </div>
  );
}
