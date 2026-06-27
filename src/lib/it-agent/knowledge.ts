// ============================================================
// Watson — H&R AI IT Agent : Knowledge Base service
// ============================================================
import { db, uuid, nowIso } from '../store/db';
import { writeAudit } from './audit';
import { seedAll } from './seed-knowledge';
import type { Actor, KnowledgeArticle, TicketCategory } from './types';

export function ensureSeeded() {
  seedAll(false);
}

export function listArticles(opts?: { includeInternal?: boolean; category?: TicketCategory }): KnowledgeArticle[] {
  ensureSeeded();
  let rows = [...db().knowledge];
  if (!opts?.includeInternal) rows = rows.filter((a) => a.visibility === 'public');
  if (opts?.category) rows = rows.filter((a) => a.category === opts.category);
  return rows.sort((a, b) => a.title.localeCompare(b.title));
}

export function getArticleBySlug(slug: string): KnowledgeArticle | undefined {
  ensureSeeded();
  return db().knowledge.find((a) => a.slug === slug);
}

export function searchArticles(query: string, opts?: { includeInternal?: boolean; category?: TicketCategory; limit?: number }): KnowledgeArticle[] {
  ensureSeeded();
  const q = query.trim().toLowerCase();
  let rows = listArticles({ includeInternal: opts?.includeInternal, category: opts?.category });
  if (q) {
    rows = rows.filter(
      (a) =>
        a.title.toLowerCase().includes(q) ||
        a.summary.toLowerCase().includes(q) ||
        a.body.toLowerCase().includes(q) ||
        a.tags.some((t) => t.includes(q))
    );
  }
  return rows.slice(0, opts?.limit ?? 20);
}

export function createArticle(
  actor: Actor,
  input: { title: string; slug?: string; category: TicketCategory; summary: string; body: string; tags?: string[]; visibility?: 'public' | 'internal' }
): KnowledgeArticle {
  ensureSeeded();
  const slug =
    input.slug?.trim() ||
    input.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
  const article: KnowledgeArticle = {
    id: uuid(),
    slug,
    title: input.title,
    category: input.category,
    summary: input.summary,
    body: input.body,
    tags: input.tags ?? [],
    visibility: input.visibility ?? 'public',
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  db().knowledge.push(article);
  writeAudit({
    actorType: actor.type,
    actorId: actor.id,
    action: 'knowledge_article_created',
    targetType: 'knowledge_article',
    targetId: slug,
    afterState: { title: article.title, category: article.category }
  });
  return article;
}

export function updateArticle(actor: Actor, slug: string, patch: Partial<Pick<KnowledgeArticle, 'title' | 'summary' | 'body' | 'tags' | 'visibility' | 'category'>>): KnowledgeArticle | null {
  ensureSeeded();
  const article = db().knowledge.find((a) => a.slug === slug);
  if (!article) return null;
  const before = { ...article };
  Object.assign(article, patch, { updatedAt: nowIso() });
  writeAudit({
    actorType: actor.type,
    actorId: actor.id,
    action: 'knowledge_article_updated',
    targetType: 'knowledge_article',
    targetId: slug,
    beforeState: { title: before.title },
    afterState: { title: article.title }
  });
  return article;
}
