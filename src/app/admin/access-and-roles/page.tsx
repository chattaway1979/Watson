// ============================================================
// Watson — 021B : Administration → Access and Roles (server entry)
// ------------------------------------------------------------
// The server authorization check runs HERE as well as on every API route. The
// page-level check exists so an unauthorized administrator sees a clear refusal
// instead of an empty shell — it is NOT the security boundary. Direct API calls
// are refused independently by the security core, so hiding the UI never
// becomes the thing standing between someone and a role change.
// ============================================================
import { headers } from 'next/headers';
import { trustedIdentityFromHeaders } from '@/lib/it-agent/rbac/http';
import { actorHasCapability, currentRoles } from '@/lib/it-agent/rbac/service';
import { AccessAndRoles } from '@/components/it-agent/rbac/AccessAndRoles';

export const dynamic = 'force-dynamic';

export default async function AccessAndRolesPage() {
  const h = await headers();
  const actor = trustedIdentityFromHeaders(h);
  const authorized = actor ? actorHasCapability(actor, 'rbac.registry.read') : false;

  if (!authorized) {
    return (
      <main className="min-h-screen bg-slate-950 p-6">
        <div className="mx-auto max-w-lg rounded-2xl border border-slate-700 bg-slate-900 p-6 text-slate-200">
          <h1 className="text-lg font-semibold">Access and Roles</h1>
          <p className="mt-2 text-sm text-slate-300">
            {actor
              ? 'You do not have permission to administer Watson roles.'
              : 'Please sign in to continue.'}
          </p>
          <p className="mt-3 text-xs text-slate-400">
            Ask a Watson role administrator if you need this access.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 p-4 sm:p-8">
      <AccessAndRoles
        actorRoles={currentRoles(actor!.oid)}
        actorOid={actor!.oid}
      />
    </main>
  );
}
