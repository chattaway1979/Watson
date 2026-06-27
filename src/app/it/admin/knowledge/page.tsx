import { PageShell } from '@/components/it-agent/WatsonHeader';
import { KnowledgeAdmin } from '@/components/it-agent/KnowledgeAdmin';
export default function KnowledgeAdminPage() {
  return <PageShell title="Knowledge Base" subtitle="Seeded H&R IT articles used in Watson troubleshooting flows."><KnowledgeAdmin /></PageShell>;
}
