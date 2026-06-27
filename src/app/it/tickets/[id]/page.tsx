import { PageShell } from '@/components/it-agent/WatsonHeader';
import { TicketDetail } from '@/components/it-agent/TicketDetail';

export default async function TicketDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <PageShell title="Ticket">
      <TicketDetail id={id} />
    </PageShell>
  );
}