import { headers } from 'next/headers';
import { getServerActor } from '@/lib/it-agent/session';
import { roleAtLeast } from '@/lib/it-agent/constants';
import { PageShell } from '@/components/it-agent/WatsonHeader';
import { DiagnosticsClient } from '@/components/it-agent/DiagnosticsClient';

// Server-gated: the actor is resolved from the trusted session seam (verified
// Entra principal in production; demo role in dev). Non-admins never see the
// console; the underlying APIs enforce the same rule authoritatively.
export const dynamic = 'force-dynamic';

export default async function DiagnosticsPage() {
  const h = await headers();
  const actor = getServerActor({ headers: h });
  const isAdmin = Boolean(actor && roleAtLeast(actor.role, 'admin'));

  return (
    <PageShell
      title="Microsoft 365 Diagnostics"
      subtitle="Read-only diagnostics — mock by default, live Microsoft Graph only when the live-read gate is deliberately enabled. No write or remediation actions."
    >
      {isAdmin ? (
        <DiagnosticsClient />
      ) : (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          This console requires an <b>administrator</b>. Access is enforced server-side and by the diagnostics APIs.
        </div>
      )}
    </PageShell>
  );
}
