'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CategoryBadge } from './Badges';
import { api } from './api';

interface Article { slug: string; title: string; category: string; summary: string; body: string; tags: string[]; visibility: string; }

export function KnowledgeArticleView({ slug }: { slug: string }) {
  const [a, setA] = useState<Article | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<Article[]>('/api/it-agent/knowledge').then((r) => {
      if (r.ok) { const found = r.data.find((x) => x.slug === slug); if (found) setA(found); else setErr('Article not found or not visible to your role.'); }
      else setErr(r.error);
    });
  }, [slug]);
  if (err) return <p className="text-sm text-red-600">{err} <Link className="underline" href="/it/help">Back to help</Link></p>;
  if (!a) return <p className="text-sm text-watson-mist">Loading…</p>;
  return (
    <article className="rounded-2xl border border-watson-line bg-white p-5 shadow-sm">
      <div className="mb-2"><CategoryBadge category={a.category} /></div>
      <h2 className="text-xl font-semibold text-watson-ink">{a.title}</h2>
      <p className="mt-1 text-sm text-watson-mist">{a.summary}</p>
      <div className="mt-4 space-y-2 text-sm text-watson-steel">
        {a.body.split('\n').map((line, i) => <p key={i} className="whitespace-pre-wrap">{line}</p>)}
      </div>
      {a.tags.length > 0 && <div className="mt-4 flex flex-wrap gap-1">{a.tags.map((t) => <span key={t} className="rounded bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">#{t}</span>)}</div>}
    </article>
  );
}
