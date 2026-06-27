import { PageShell } from '@/components/it-agent/WatsonHeader';
import { ActionRegistryTable } from '@/components/it-agent/ActionRegistryTable';
export default function ActionsPage() {
  return <PageShell title="Action Registry" subtitle="Every IT action Watson knows about, with risk, role, approval, and execution metadata."><ActionRegistryTable /></PageShell>;
}
