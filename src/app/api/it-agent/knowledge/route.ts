import { actorFromRequest } from '@/lib/it-agent/session';
import { listArticles, searchArticles, createArticle } from '@/lib/it-agent/knowledge';
import { roleAtLeast } from '@/lib/it-agent/constants';
import { ok, fail } from '@/lib/http';
import type { TicketCategory } from '@/lib/it-agent/types';

export async function GET(req: Request) {
  const actor = actorFromRequest(req);
  const url = new URL(req.url);
  const q = url.searchParams.get('q') ?? '';
  const category = (url.searchParams.get('category') as TicketCategory) || undefined;
  const includeInternal = roleAtLeast(actor.role, 'admin');
  const rows = q ? searchArticles(q, { includeInternal, category }) : listArticles({ includeInternal, category });
  return ok(rows);
}

export async function POST(req: Request) {
  const actor = actorFromRequest(req);
  if (!roleAtLeast(actor.role, 'admin')) return fail('Admin role required to manage knowledge.', 403);
  const body = (await req.json().catch(() => ({}))) as { title?: string; category?: TicketCategory; summary?: string; body?: string; tags?: string[]; visibility?: 'public' | 'internal' };
  if (!body.title || !body.summary || !body.body || !body.category) return fail('title, category, summary, body are required.', 400);
  const art = createArticle(actor, { title: body.title, category: body.category, summary: body.summary, body: body.body, tags: body.tags, visibility: body.visibility });
  return ok(art);
}
