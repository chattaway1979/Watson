import { PageShell } from '@/components/it-agent/WatsonHeader';
import { AdminTicketQueue } from '@/components/it-agent/AdminTicketQueue';
export default function AdminTicketsPage() {
  return <PageShell title="Ticket Queue" subtitle="All tickets across H&R Electric. Filter and drill in."><AdminTicketQueue /></PageShell>;
}
