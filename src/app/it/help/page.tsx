import { PageShell } from '@/components/it-agent/WatsonHeader';
import { ItHelpClient } from '@/components/it-agent/ItHelpClient';

export default function HelpPage() {
  return (
    <PageShell title="IT Help" subtitle="Watson — your calm, controlled internal IT operator for H&R Electric.">
      <ItHelpClient />
    </PageShell>
  );
}
