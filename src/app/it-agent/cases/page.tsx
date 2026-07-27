import { headers } from 'next/headers';
import { getServerActor } from '@/lib/it-agent/session';
import { roleAtLeast } from '@/lib/it-agent/constants';
import { PageShell } from '@/components/it-agent/WatsonHeader';
import { CasesQueue } from '@/components/it-agent/watson/CasesQueue';

export const dynamic = 'force-dynamic';

export default async function CasesPage() {
  const h = await headers();
  const actor = getServerActor({ headers: h });
  const isAdmin = Boolean(actor && roleAtLeast(actor.role, 'admin'));

  return (
    <PageShell title="Support Cases" subtitle="Watson employee support cases — queue and status. Read-only; no remediation controls.">
      {isAdmin ? <CasesQueue /> : (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          This queue requires an <b>administrator</b>. Access is enforced server-side and by the cases API.
        </div>
      )}
    </PageShell>
  );
}
