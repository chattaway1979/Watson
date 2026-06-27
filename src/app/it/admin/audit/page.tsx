import { PageShell } from '@/components/it-agent/WatsonHeader';
import { AuditTimeline } from '@/components/it-agent/AuditTimeline';
export default function AuditPage() {
  return <PageShell title="Audit Log" subtitle="Backend-owned, append-only record of every meaningful event."><AuditTimeline /></PageShell>;
}
