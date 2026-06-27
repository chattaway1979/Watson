import { PageShell } from '@/components/it-agent/WatsonHeader';
import { TicketList } from '@/components/it-agent/TicketList';

export default function MyTicketsPage() {
  return (
    <PageShell title="My Tickets" subtitle="Tickets you have opened with Watson / the IT team.">
      <TicketList scope="mine" />
    </PageShell>
  );
}
