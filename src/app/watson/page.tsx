import { headers } from 'next/headers';
import { getServerActor } from '@/lib/it-agent/session';
import { WatsonShell } from '@/components/it-agent/watson/WatsonShell';

// Employee-facing Watson. Requires an authenticated user (any role). The
// underlying APIs enforce authentication and own-case-only access authoritatively.
export const dynamic = 'force-dynamic';

export default async function WatsonPage() {
  const h = await headers();
  const actor = getServerActor({ headers: h });

  if (!actor) {
    return (
      <main className="min-h-screen bg-slate-950 p-6">
        <div className="mx-auto max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 text-center text-slate-200">
          Please sign in to talk to Watson.
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 p-4 sm:p-8">
      <div className="mx-auto mb-4 flex max-w-2xl items-center justify-between text-xs text-slate-400">
        <span className="font-semibold text-slate-200">Watson</span>
        <nav className="flex gap-3">
          <span>Current Issue</span>
          <span className="opacity-60">Issue History</span>
          <span className="opacity-60">Settings</span>
        </nav>
      </div>
      <WatsonShell />
    </main>
  );
}
