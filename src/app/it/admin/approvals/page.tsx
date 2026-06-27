import { PageShell } from '@/components/it-agent/WatsonHeader';
import { ApprovalQueue } from '@/components/it-agent/ApprovalQueue';
export default function ApprovalsPage() {
  return <PageShell title="Approval Queue" subtitle="Approve or reject prepared actions. Approved actions are simulated only — live execution is disabled."><ApprovalQueue /></PageShell>;
}
