'use client';
export function MockModeBanner({ mode = 'mock', live = false }: { mode?: string; live?: boolean }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <span className="mt-0.5 text-base leading-none">🛡️</span>
      <p>
        <span className="font-semibold">{mode === 'live' ? 'LIVE' : 'MOCK MODE'}</span> — live external IT execution is{' '}
        <span className="font-semibold">{live ? 'ENABLED' : 'DISABLED'}</span>. Risky and critical actions are queued for
        human approval and simulated only. No real Microsoft 365, Entra, Intune, NinjaOne, or Atera calls are made.
      </p>
    </div>
  );
}
