'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { WatsonAvatar } from './WatsonAvatar';
import { api, setRole, getCookieRole } from './api';

interface SessionInfo {
  authMode?: string;
  actor: { role: string; displayName?: string };
  mode: string;
  liveExecutionEnabled: boolean;
  ai: { name: string; fallback: boolean };
}

const EMP_NAV = [
  { href: '/it/help', label: 'Get Help' },
  { href: '/it/tickets', label: 'My Tickets' }
];
const ADMIN_NAV = [
  { href: '/it/admin', label: 'Dashboard' },
  { href: '/it/admin/tickets', label: 'Tickets' },
  { href: '/it/admin/approvals', label: 'Approvals' },
  { href: '/it/admin/audit', label: 'Audit' },
  { href: '/it/admin/knowledge', label: 'Knowledge' },
  { href: '/it/admin/actions', label: 'Actions' }
];

export function WatsonHeader() {
  const pathname = usePathname();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [role, setRoleState] = useState<string>('employee');
  const isAdminArea = pathname?.startsWith('/it/admin');
  const nav = isAdminArea ? ADMIN_NAV : EMP_NAV;

  useEffect(() => {
    setRoleState(getCookieRole());
    api<SessionInfo>('/api/it-agent/session').then((r) => { if (r.ok) setSession(r.data); });
  }, [pathname]);

  async function changeRole(r: string) {
    setRoleState(r);
    await setRole(r);
    window.location.reload();
  }

  return (
    <header className="sticky top-0 z-20 border-b border-watson-line bg-watson-ink text-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <Link href="/it/help" className="flex items-center gap-3">
          <WatsonAvatar size={40} />
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight">Watson</div>
            <div className="text-[11px] text-slate-300">H&amp;R AI IT Agent</div>
          </div>
        </Link>

        <nav className="order-3 flex w-full gap-1 overflow-x-auto sm:order-2 sm:w-auto">
          {nav.map((n) => {
            const active = pathname === n.href;
            return (
              <Link
                key={n.href}
                href={n.href}
                className={`whitespace-nowrap rounded-md px-3 py-2 text-sm ${active ? 'bg-white/15 font-medium text-white' : 'text-slate-300 hover:bg-white/10'}`}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>

        {/* Demo role switcher is DEV/TEST only. In Entra mode identity comes from
            the verified session, so the switcher is hidden (and the server ignores
            watson_role / refuses role changes). */}
        {session?.authMode === 'entra' ? (
          <div className="order-2 ml-auto flex items-center gap-2 sm:order-3">
            <span className="rounded-md border border-white/20 bg-white/10 px-2 py-1 text-[11px] text-slate-200">
              {session.actor.displayName ? `${session.actor.displayName} · ` : ''}Signed in
            </span>
          </div>
        ) : (
          <div className="order-2 ml-auto flex items-center gap-2 sm:order-3">
            <span className="hidden text-[11px] text-slate-400 sm:inline">Demo role</span>
            <select
              value={role}
              onChange={(e) => changeRole(e.target.value)}
              className="rounded-md border border-white/20 bg-white/10 px-2 py-2 text-xs text-white"
              aria-label="Switch demo role"
            >
              <option className="text-black" value="employee">Employee</option>
              <option className="text-black" value="manager">Manager</option>
              <option className="text-black" value="admin">Admin</option>
              <option className="text-black" value="owner">Owner</option>
            </select>
          </div>
        )}
      </div>
      {session && (
        <div className="bg-watson-slate/60 px-4 py-1 text-center text-[11px] text-slate-300">
          {session.mode === 'live' ? '🔴 LIVE' : '🟢 MOCK MODE'} · live execution {session.liveExecutionEnabled ? 'ENABLED' : 'disabled'} · AI: {session.ai.name}{session.ai.fallback ? ' (deterministic fallback)' : ''}
        </div>
      )}
    </header>
  );
}

export function PageShell({ children, title, subtitle }: { children: React.ReactNode; title?: string; subtitle?: string }) {
  return (
    <div className="min-h-screen bg-watson-bg">
      <WatsonHeader />
      <main className="mx-auto max-w-6xl px-4 py-6">
        {title && (
          <div className="mb-5">
            <h1 className="text-xl font-semibold text-watson-ink">{title}</h1>
            {subtitle && <p className="mt-1 text-sm text-watson-mist">{subtitle}</p>}
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
