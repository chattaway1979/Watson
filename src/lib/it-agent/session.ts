// ============================================================
// Watson — H&R AI IT Agent : Demo Identity / Session helper
// ------------------------------------------------------------
// THIS BUILD HAS NO REAL AUTH. For the controlled MVP, identity
// is supplied by a signed-out "role switcher" via the
// `watson_role` cookie (or X-Watson-Role header). This is an
// explicit, documented assumption. Production must replace this
// with Microsoft Entra ID / NextAuth and real role claims.
// Backend policy enforcement does NOT depend on the UI — it
// depends on the Actor resolved here server-side.
// ============================================================
import type { Actor, Role } from './types';

const DEMO_IDENTITIES: Record<Role, Actor> = {
  employee: { id: 'demo-employee', type: 'user', role: 'employee', email: 'carlos.field@hrelectriccompany.com', displayName: 'Carlos Field (Employee)' },
  manager: { id: 'demo-manager', type: 'user', role: 'manager', email: 'mike.pm@hrelectriccompany.com', displayName: 'Mike Rivera (Manager)' },
  admin: { id: 'demo-admin', type: 'admin', role: 'admin', email: 'admin.it@hrelectriccompany.com', displayName: 'Watson Admin' },
  owner: { id: 'demo-owner', type: 'admin', role: 'owner', email: 'owner@hrelectriccompany.com', displayName: 'Company Owner' },
  agent: { id: 'watson', type: 'agent', role: 'agent', email: 'watson@hrelectriccompany.com', displayName: 'Watson Agent' },
  system: { id: 'system', type: 'system', role: 'system', email: 'system@hrelectriccompany.com', displayName: 'System' }
};

const VALID_ROLES: Role[] = ['employee', 'manager', 'admin', 'owner'];

export function actorForRole(role: string | undefined | null): Actor {
  const r = (role ?? 'employee').toLowerCase() as Role;
  if (VALID_ROLES.includes(r)) return DEMO_IDENTITIES[r];
  return DEMO_IDENTITIES.employee;
}

// Resolve actor from a Next.js Request (header first, then cookie).
export function actorFromRequest(req: Request): Actor {
  const header = req.headers.get('x-watson-role');
  if (header) return actorForRole(header);
  const cookie = req.headers.get('cookie') ?? '';
  const m = cookie.match(/(?:^|;\s*)watson_role=([^;]+)/);
  return actorForRole(m?.[1]);
}

export function demoIdentities() {
  return VALID_ROLES.map((r) => ({ ...DEMO_IDENTITIES[r], role: r }));
}
