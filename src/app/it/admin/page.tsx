import { PageShell } from '@/components/it-agent/WatsonHeader';
import { AdminDashboard } from '@/components/it-agent/AdminDashboard';
export default function AdminPage() {
  return (
    <PageShell title="Admin Dashboard" subtitle="Operational overview — tickets, approvals, connectors, and safety state.">
      <AdminDashboard />
    </PageShell>
  );
}
