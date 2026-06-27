import { PageShell } from '@/components/it-agent/WatsonHeader';
import { KnowledgeArticleView } from '@/components/it-agent/KnowledgeArticleView';

export default async function ArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <PageShell title="Knowledge Article">
      <KnowledgeArticleView slug={slug} />
    </PageShell>
  );
}