'use client';
// ============================================================
// Watson — 021B : Access and Roles administrator interface
// ------------------------------------------------------------
// Six views as interface states: landing, search, employee detail, assignment
// preview, removal preview, audit history.
//
// The client NEVER decides authorization, never synthesizes an assignment, and
// never updates optimistically. Every label, capability, risk and warning is
// read from the server's registry response, so the UI cannot drift from what
// the server actually enforces. Confirmations go through the server-issued
// preview nonce only; there is no path that constructs a mutation directly.
// ============================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import type { WatsonRoleKey } from '@/lib/it-agent/rbac/roles';

type View = 'landing' | 'detail' | 'assign' | 'remove' | 'audit';

interface RoleMeta {
  key: WatsonRoleKey; displayName: string; description: string;
  capabilities: string[]; risk: string; status: 'functional' | 'reserved';
  requiresElevatedConfirmation: boolean;
}
interface Entry {
  oid: string; displayName: string; upn: string;
  mail?: string | null; accountEnabled?: boolean | null; userType?: string | null;
  employeeEligibility?: 'eligible' | 'not_eligible' | 'ambiguous';
  eligibilityReasonCode?: string;
  selectionAllowed?: boolean;
}

// 021E: plain operational language for each policy decision. The wording never
// asserts that someone IS an employee unless the policy actually concluded that.
const ELIGIBILITY_LABEL: Record<string, { badge: string; note: string; tone: 'ok' | 'warn' | 'blocked' }> = {
  eligible_employee:              { badge: 'Active employee', note: '', tone: 'ok' },
  explicitly_allowed:             { badge: 'Allowed by policy', note: 'Allowed by explicit Watson configuration.', tone: 'ok' },
  disabled_account:               { badge: 'Disabled account', note: 'This account is disabled and cannot sign in. Watson roles cannot be assigned to it.', tone: 'blocked' },
  guest_account:                  { badge: 'Guest or external', note: 'This is a guest or external account, not an H&R Electric employee account.', tone: 'blocked' },
  excluded_service_identity:      { badge: 'Service identity', note: 'This looks like a service or automation account, not a person.', tone: 'blocked' },
  excluded_shared_mailbox:        { badge: 'Shared mailbox', note: 'This looks like a shared mailbox, not an individual employee.', tone: 'blocked' },
  excluded_bootstrap_identity:    { badge: 'Administrative identity', note: 'This is a tenant administrative or emergency-access identity. It must not be given Watson roles in normal operation.', tone: 'blocked' },
  excluded_cross_tenant_identity: { badge: 'Outside H&R Electric', note: 'This identity belongs to another organisation.', tone: 'blocked' },
  ambiguous_member:               { badge: 'Unconfirmed', note: 'Watson cannot confirm this is an employee account. Verify with IT before granting access.', tone: 'warn' },
  explicitly_excluded:            { badge: 'Excluded by policy', note: 'Excluded by explicit Watson configuration.', tone: 'blocked' }
};
interface Preview {
  nonce: string; operation: 'assign' | 'remove'; targetOid: string; role: WatsonRoleKey;
  roleDisplayName: string; roleStatus: string; risk: string;
  currentRoles: WatsonRoleKey[]; resultingRoles: WatsonRoleKey[];
  capabilitiesGained: string[]; capabilitiesLost: string[];
  sodWarnings: string[]; lastAdminImplication: string | null;
  requiresElevatedAcknowledgement: boolean; disclaimer: string;
}
interface AuditRow {
  id: string; at: string; actorOid: string; targetOid: string | null; operation: string;
  outcome: 'success' | 'refused' | 'error'; reason: string; role?: string;
  previousRoles: string[] | null; resultingRoles: string[] | null;
  source: string; correlationId: string; elevatedAcknowledged: boolean | null;
}
interface Problem { message: string; nextAction: string }

const WATSON_ONLY =
  'These roles control Watson application access only. They do not grant Microsoft 365, Entra, Azure, Exchange or Defender administrator permissions.';

async function api<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; problem: Problem; status: number }> {
  try {
    const r = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, status: r.status, problem: { message: body.message ?? 'The request was refused.', nextAction: body.nextAction ?? 'Refresh and try again.' } };
    }
    return { ok: true, data: body as T };
  } catch {
    return { ok: false, status: 0, problem: { message: 'Watson could not reach the server.', nextAction: 'Check your connection and try again.' } };
  }
}

export function AccessAndRoles({ actorRoles, actorOid }: { actorRoles: WatsonRoleKey[]; actorOid: string }) {
  const [view, setView] = useState<View>('landing');
  const [registry, setRegistry] = useState<Record<string, RoleMeta> | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Entry[] | null>(null);
  // 021D: the directory label is whatever the SERVER reported for the rows it
  // actually returned. The client never infers "live" from configuration.
  const [directory, setDirectory] = useState<{ source: string; provenanceMismatch?: boolean } | null>(null);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [roles, setRoles] = useState<WatsonRoleKey[] | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [ack, setAck] = useState(false);
  const [audit, setAudit] = useState<AuditRow[] | null>(null);
  const [auditFilter, setAuditFilter] = useState<'all' | 'success' | 'refused'>('all');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [status, setStatus] = useState<string>('');
  const [busy, setBusy] = useState(false);
  // Guards double-click / rapid resubmit of a non-idempotent confirmation.
  const inFlight = useRef(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // 021C-1B: the preview is a VIEW SWAP, not an overlay, so the button that
  // opened it is unmounted by the time focus should come back. Storing the
  // element meant `.focus()` was called on a detached node and focus silently
  // fell to <body>. Store a stable KEY instead and re-find the control after the
  // view returns — falling back to the section heading when the trigger no
  // longer exists (an assigned role moves from "Assign" to "Remove").
  const returnFocusKey = useRef<string | null>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const landingHeadingRef = useRef<HTMLHeadingElement | null>(null);

  // Revocation handling: any 401/403 tears down privileged content rather than
  // leaving stale administrative controls on screen.
  const handleAuthLoss = useCallback((s: number) => {
    if (s === 401 || s === 403) {
      setRegistry(null); setResults(null); setSelected(null); setRoles(null);
      setPreview(null); setAudit(null); setView('landing');
      setStatus('Your administrative access has changed. The page has been cleared.');
      return true;
    }
    return false;
  }, []);

  useEffect(() => {
    (async () => {
      const r = await api<{ roles: Record<string, RoleMeta> }>('/api/it-agent/rbac/registry');
      if (r.ok) setRegistry(r.data.roles);
      else { handleAuthLoss(r.status); setProblem(r.problem); }
    })();
  }, [handleAuthLoss]);

  async function runSearch() {
    setProblem(null);
    if (query.trim().length < 3) { setProblem({ message: 'Enter at least 3 characters.', nextAction: 'Type more of the name or email.' }); return; }
    setSearching(true);
    const r = await api<{ results: Entry[]; source: string; truncated: boolean; provenanceMismatch?: boolean }>(`/api/it-agent/rbac/search?q=${encodeURIComponent(query.trim())}`);
    setSearching(false);
    if (!r.ok) { handleAuthLoss(r.status); setProblem(r.problem); setResults([]); setDirectory(null); return; }
    setResults(r.data.results);
    // The label is whatever the SERVER said about the rows it just returned.
    setDirectory({ source: r.data.source, provenanceMismatch: r.data.provenanceMismatch });
    setStatus(`${r.data.results.length} result${r.data.results.length === 1 ? '' : 's'}.`);
  }

  async function loadRoles(e: Entry) {
    setSelected(e); setPreview(null); setProblem(null);
    const r = await api<{ roles: WatsonRoleKey[] }>(`/api/it-agent/rbac/employee?oid=${encodeURIComponent(e.oid)}`);
    if (!r.ok) { handleAuthLoss(r.status); setProblem(r.problem); return; }
    setRoles(r.data.roles); setView('detail');
  }

  // Re-find the control that opened the dialog. If it is gone (the role moved
  // between the "assign" and "remove" lists) fall back to the sibling control for
  // the same role, then to the section heading — never to <body>.
  const restoreFocus = useCallback(() => {
    const key = returnFocusKey.current;
    if (key) {
      const exact = document.querySelector<HTMLElement>(`[data-rbac-trigger="${key}"]`);
      if (exact) { exact.focus(); return; }
      const role = key.split(':')[1];
      const sibling = document.querySelector<HTMLElement>(`[data-rbac-trigger$=":${role}"]`);
      if (sibling) { sibling.focus(); return; }
    }
    detailHeadingRef.current?.focus();
  }, []);

  // Focus must be restored AFTER React has re-rendered the detail view, or the
  // trigger does not exist yet and the heading effect wins the race.
  const pendingRestore = useRef(false);
  function closePreview() {
    pendingRestore.current = true;
    setPreview(null); setAck(false); setView('detail');
  }

  async function openPreview(op: 'assign' | 'remove', role: WatsonRoleKey) {
    if (!selected) return;
    returnFocusKey.current = `${op}:${role}`;
    setProblem(null); setAck(false);
    const r = await api<Preview>(`/api/it-agent/rbac/${op}/preview`, {
      method: 'POST',
      body: JSON.stringify({ targetOid: selected.oid, role, displayName: selected.displayName })
    });
    if (!r.ok) { handleAuthLoss(r.status); setProblem(r.problem); return; }
    setPreview(r.data); setView(op);
  }

  async function confirm() {
    if (!preview || inFlight.current) return;
    // Double-submit guard: a second click cannot spend the nonce twice, and the
    // server would refuse the replay anyway.
    inFlight.current = true; setBusy(true); setProblem(null);
    const op = preview.operation;
    const r = await api<{ applied: boolean; roles: WatsonRoleKey[]; idempotent: boolean }>(
      `/api/it-agent/rbac/${op}/confirm`,
      { method: 'POST', body: JSON.stringify({ nonce: preview.nonce, targetOid: preview.targetOid, role: preview.role, elevatedAcknowledged: ack }) }
    );
    setBusy(false); inFlight.current = false;
    if (!r.ok) {
      if (handleAuthLoss(r.status)) return;
      setProblem(r.problem);
      // A stale or replayed preview must not stay on screen as if usable.
      if (r.status === 409) { setPreview(null); setView('detail'); await refreshRoles(); }
      return;
    }
    // Never optimistic — roles come back from the server.
    setRoles(r.data.roles);
    setStatus(r.data.idempotent
      ? `No change needed — ${preview.roleDisplayName} was already ${op === 'assign' ? 'assigned' : 'absent'}.`
      : `${preview.roleDisplayName} ${op === 'assign' ? 'assigned' : 'removed'}.`);
    closePreview();
  }

  async function refreshRoles() {
    if (!selected) return;
    const r = await api<{ roles: WatsonRoleKey[] }>(`/api/it-agent/rbac/employee?oid=${encodeURIComponent(selected.oid)}`);
    if (r.ok) setRoles(r.data.roles); else handleAuthLoss(r.status);
  }

  async function openAudit(oid?: string) {
    setProblem(null);
    const r = await api<{ events: AuditRow[] }>(`/api/it-agent/rbac/audit${oid ? `?oid=${encodeURIComponent(oid)}` : ''}`);
    if (!r.ok) { handleAuthLoss(r.status); setProblem(r.problem); return; }
    setAudit(r.data.events); setView('audit');
  }

  // ------------------------------------------------------------
  // Dialog focus management for the two preview states.
  //
  // 021C-1B browser validation found three real defects here: Escape did not
  // dismiss the dialog, Tab walked straight out of an aria-modal dialog, and
  // focus was never restored to the control that opened it. All three are fixed
  // together because they are one behaviour: a modal owns the keyboard while it
  // is open and hands focus back when it closes.
  // ------------------------------------------------------------
  const dialogOpen = view === 'assign' || view === 'remove';

  useEffect(() => {
    if (dialogOpen) { dialogRef.current?.focus(); return; }
    if (pendingRestore.current) { pendingRestore.current = false; restoreFocus(); return; }
    if (view === 'detail') detailHeadingRef.current?.focus();
    else if (view === 'landing') landingHeadingRef.current?.focus();
  }, [dialogOpen, view, roles, restoreFocus]);

  useEffect(() => {
    if (!dialogOpen) return;
    const node = dialogRef.current;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Escape must never commit; it is exactly the Cancel path. Focus is
        // restored by the view effect once the detail view has re-rendered.
        e.preventDefault();
        closePreview();
        return;
      }
      if (e.key !== 'Tab' || !node) return;
      // Focus trap: an aria-modal dialog must contain the tab ring.
      const focusables = [...node.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
      )].filter((el) => el.offsetParent !== null);
      if (!focusables.length) { e.preventDefault(); node.focus(); return; }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || active === node)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
      else if (active && !node.contains(active)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [dialogOpen, restoreFocus]);

  const canConfirm = preview ? (!preview.requiresElevatedAcknowledgement || ack) && !busy && !preview.lastAdminImplication?.includes('will be refused') : false;
  const roleList = registry ? Object.values(registry) : [];
  const isRoleAdmin = actorRoles.includes('watson_role_admin');

  return (
    <div className="mx-auto max-w-3xl space-y-5 text-slate-100">
      <header>
        <h1 className="text-xl font-semibold">Administration — Access and Roles</h1>
        <p className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-100" role="note">
          {WATSON_ONLY}
        </p>
        <p className="mt-2 text-xs text-slate-400">
          Your Watson authority: {actorRoles.length ? actorRoles.join(', ') : 'none'}
          {isRoleAdmin ? ' — you can assign and remove Watson roles.' : ' — you cannot administer roles.'}
        </p>
      </header>

      {/* Live region: success and error are announced, not just coloured. */}
      <p aria-live="polite" className="sr-only">{status}</p>
      {problem ? (
        <div role="alert" className="rounded-lg border border-rose-500/50 bg-rose-500/10 p-3 text-sm text-rose-100">
          <strong className="block">⚠ {problem.message}</strong>
          <span className="text-rose-200/90">{problem.nextAction}</span>
        </div>
      ) : null}
      {status ? (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-100">✓ {status}</div>
      ) : null}

      {/* ---- Landing + search ---- */}
      {view === 'landing' ? (
        <section className="space-y-4">
          {/* Focusable so a view change never drops the keyboard at <body>. */}
          <h2 ref={landingHeadingRef} tabIndex={-1} className="text-base font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300">Find an employee</h2>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <label htmlFor="rbac-q" className="sr-only">Search employees by name or email</label>
            <input
              id="rbac-q" value={query} onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
              placeholder="Name or email (min 3 characters)"
              className="min-w-0 flex-1 rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300"
            />
            <button onClick={runSearch} disabled={searching}
              className="rounded-lg bg-sky-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300">
              {searching ? 'Searching…' : 'Search'}
            </button>
            <button onClick={() => openAudit()}
              className="rounded-lg border border-slate-600 px-4 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300">
              Audit history
            </button>
          </div>
          <p className="text-xs text-slate-400">
            {directory === null
              ? 'Directory source: shown after a search.'
              : directory.source === 'graph_live'
                ? 'Directory source: live Microsoft Entra directory (read-only lookup).'
                : 'Directory source: staged mock directory (live Microsoft Graph lookup is disabled).'}
            {directory?.provenanceMismatch ? (
              <span className="ml-1 text-amber-200">
                Live lookup is enabled but these rows are not live tenant data.
              </span>
            ) : null}
          </p>

          {results ? (
            results.length === 0
              ? <p className="text-sm text-slate-400">No matches. Try a different name or email.</p>
              : <ul className="space-y-2">
                  {results.map((e) => {
                    // Default to NOT selectable: a row whose eligibility the server
                    // did not state must never behave like a confirmed employee.
                    const allowed = e.selectionAllowed !== false;
                    const meta = ELIGIBILITY_LABEL[e.eligibilityReasonCode ?? 'eligible_employee']
                      ?? ELIGIBILITY_LABEL.ambiguous_member;
                    const edge = meta.tone === 'ok' ? 'border-slate-700'
                      : meta.tone === 'warn' ? 'border-amber-500/60' : 'border-rose-500/50';
                    const body = (
                      <>
                        {/* React escapes this — hostile display data renders as text. */}
                        <span className="block break-words font-medium">{e.displayName}</span>
                        <span className="block break-all text-xs text-slate-400">{e.upn}</span>
                        <span className="block break-all text-[11px] text-slate-500">ID ending {e.oid.slice(-6)}</span>
                        {/* Status carries a glyph + word, never colour alone. */}
                        <span className={`mt-1 inline-block rounded border px-1.5 py-0.5 text-[11px] ${
                          meta.tone === 'ok' ? 'border-emerald-500/50 text-emerald-200'
                            : meta.tone === 'warn' ? 'border-amber-500/60 text-amber-200'
                              : 'border-rose-500/60 text-rose-200'}`}>
                          {meta.tone === 'ok' ? '✓ ' : meta.tone === 'warn' ? '? ' : '✕ '}{meta.badge}
                        </span>
                        {meta.note ? (
                          <span className="mt-1 block break-words text-[11px] text-slate-400">{meta.note}</span>
                        ) : null}
                      </>
                    );
                    return (
                      <li key={e.oid}>
                        {allowed ? (
                          <button onClick={() => loadRoles(e)}
                            className={`w-full rounded-lg border ${edge} bg-slate-900 p-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300`}>
                            {body}
                          </button>
                        ) : (
                          // Deliberately NOT a button: an identity Watson cannot
                          // vouch for is not one click away from a role grant.
                          <div aria-disabled="true"
                            className={`w-full rounded-lg border ${edge} bg-slate-900/60 p-3 text-left`}>
                            {body}
                            <span className="mt-1 block text-[11px] text-slate-500">Not selectable.</span>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
          ) : null}

          <details className="rounded-lg border border-slate-700 bg-slate-900 p-3">
            <summary className="cursor-pointer text-sm font-medium">Watson role catalogue</summary>
            <ul className="mt-3 space-y-3">
              {roleList.map((r) => (
                <li key={r.key} className="rounded-lg border border-slate-700 p-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="font-medium">{r.displayName}</span>
                    <span className="rounded border border-slate-600 px-1.5 py-0.5 text-[11px] uppercase">{r.risk} risk</span>
                    {r.status === 'reserved' ? (
                      <span className="rounded border border-amber-500/60 px-1.5 py-0.5 text-[11px] text-amber-200">Reserved — not active</span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-sm text-slate-300">{r.description}</p>
                  <ul className="mt-1 list-disc pl-5 text-xs text-slate-400">
                    {r.capabilities.map((c) => <li key={c} className="break-words">{c}</li>)}
                  </ul>
                  {r.status === 'reserved' ? (
                    <p className="mt-1 text-xs text-amber-200">
                      {r.key === 'watson_provisioning_admin'
                        ? 'This role does not currently create accounts, mailboxes, licences or groups.'
                        : 'This role does not currently purge messages, block domains or modify Defender.'}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        </section>
      ) : null}

      {/* ---- Employee detail ---- */}
      {view === 'detail' && selected ? (
        <section className="space-y-3">
          <button onClick={() => { setView('landing'); setStatus(''); }} className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300">← Back to search</button>
          <h2 ref={detailHeadingRef} tabIndex={-1} className="break-words text-base font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300">{selected.displayName}</h2>
          <p className="break-all text-xs text-slate-400">{selected.upn} · ID ending {selected.oid.slice(-6)}</p>

          <h3 className="text-sm font-semibold">Current Watson roles</h3>
          {roles && roles.length ? (
            <ul className="space-y-2">
              {roles.map((k) => {
                const meta = registry?.[k];
                return (
                  <li key={k} className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 p-3">
                    <span className="min-w-0 flex-1 break-words">{meta?.displayName ?? k}</span>
                    <button onClick={() => openPreview('remove', k)}
                      data-rbac-trigger={`remove:${k}`}
                      aria-label={`Remove ${meta?.displayName ?? k}`}
                      className="rounded-lg border border-rose-500 px-3 py-1.5 text-sm text-rose-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-300">
                      ✕ Remove
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : <p className="text-sm text-slate-400">No Watson roles assigned.</p>}

          <h3 className="text-sm font-semibold">Assign a role</h3>
          <ul className="space-y-2">
            {roleList.filter((r) => !roles?.includes(r.key)).map((r) => (
              <li key={r.key} className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 p-3">
                <span className="min-w-0 flex-1 break-words">{r.displayName}
                  {r.status === 'reserved' ? <span className="ml-2 text-xs text-amber-200">(reserved)</span> : null}
                </span>
                <button onClick={() => openPreview('assign', r.key)}
                  data-rbac-trigger={`assign:${r.key}`}
                  aria-label={`Assign ${r.displayName}`}
                  className="rounded-lg bg-sky-700 px-3 py-1.5 text-sm text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300">
                  Assign
                </button>
              </li>
            ))}
          </ul>
          <button onClick={() => openAudit(selected.oid)} className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300">
            View this employee’s access history
          </button>
        </section>
      ) : null}

      {/* ---- Assignment / removal preview (dialog) ---- */}
      {(view === 'assign' || view === 'remove') && preview ? (
        <section ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="rbac-dlg"
          className="space-y-3 rounded-xl border border-slate-600 bg-slate-900 p-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300">
          <h2 id="rbac-dlg" className="text-base font-semibold">
            {view === 'assign' ? 'Confirm role assignment' : 'Confirm role removal'}
          </h2>
          <p className="break-words text-sm">{selected?.displayName} · {preview.roleDisplayName}</p>
          <p className="text-xs text-slate-400">Risk: {preview.risk} · {preview.roleStatus === 'reserved' ? 'Reserved — grants no active capability today' : 'Active role'}</p>

          <div className="grid gap-2 sm:grid-cols-2">
            <div><h3 className="text-xs font-semibold uppercase text-slate-400">Current roles</h3>
              <p className="break-words text-sm">{preview.currentRoles.join(', ') || 'none'}</p></div>
            <div><h3 className="text-xs font-semibold uppercase text-slate-400">Resulting roles</h3>
              <p className="break-words text-sm">{preview.resultingRoles.join(', ') || 'none'}</p></div>
          </div>
          {preview.capabilitiesGained.length ? (
            <div><h3 className="text-xs font-semibold uppercase text-slate-400">Gains</h3>
              <ul className="list-disc pl-5 text-sm">{preview.capabilitiesGained.map((c) => <li key={c} className="break-words">{c}</li>)}</ul></div>
          ) : null}
          {preview.capabilitiesLost.length ? (
            <div><h3 className="text-xs font-semibold uppercase text-slate-400">Loses</h3>
              <ul className="list-disc pl-5 text-sm">{preview.capabilitiesLost.map((c) => <li key={c} className="break-words">{c}</li>)}</ul></div>
          ) : null}

          {preview.sodWarnings.map((w) => (
            <p key={w} role="note" className="rounded border border-amber-500/50 bg-amber-500/10 p-2 text-sm text-amber-100">⚠ {w}</p>
          ))}
          {preview.lastAdminImplication ? (
            <p role="note" className="rounded border border-rose-500/60 bg-rose-500/10 p-2 text-sm text-rose-100">⚠ {preview.lastAdminImplication}</p>
          ) : null}
          {preview.targetOid === actorOid && view === 'remove' ? (
            <p role="note" className="rounded border border-rose-500/60 bg-rose-500/10 p-2 text-sm text-rose-100">
              ⚠ This removes your own access. It takes effect on your next request.
            </p>
          ) : null}

          <p className="rounded border border-slate-600 p-2 text-xs text-slate-300">{preview.disclaimer}</p>

          {preview.requiresElevatedAcknowledgement ? (
            <label className="flex items-start gap-2 text-sm">
              {/* 021C-1B: described by the reason the confirm control is blocked,
                  not by the dialog title, which said nothing useful. */}
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)}
                aria-describedby="rbac-ack-hint"
                className="mt-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300" />
              <span>I understand this is a high-impact Watson role change.</span>
            </label>
          ) : null}
          {/* The blocking reason is real text in the dialog, so it is announced —
              a `title` on a disabled button is not reliably conveyed. */}
          {!canConfirm ? (
            <p id="rbac-ack-hint" className="text-sm text-amber-200">
              {preview.lastAdminImplication?.includes('will be refused')
                ? 'This removal is blocked: Watson requires at least one role administrator.'
                : 'Tick the acknowledgement above to enable confirmation.'}
            </p>
          ) : null}

          <div className="flex min-w-0 flex-wrap gap-2">
            <button onClick={confirm} disabled={!canConfirm}
              aria-describedby={!canConfirm ? 'rbac-ack-hint' : undefined}
              title={!canConfirm ? 'Acknowledge the elevated risk to continue' : undefined}
              className={`rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300 ${view === 'remove' ? 'bg-rose-700' : 'bg-sky-700'}`}>
              {busy ? 'Working…' : view === 'assign' ? 'Confirm assignment' : 'Confirm removal'}
            </button>
            <button onClick={closePreview}
              className="rounded-lg border border-slate-600 px-4 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300">
              Cancel
            </button>
          </div>
          <p className="text-xs text-slate-400">Press Escape to cancel.</p>
        </section>
      ) : null}

      {/* ---- Audit history ---- */}
      {view === 'audit' ? (
        <section className="space-y-3">
          <button onClick={() => setView(selected ? 'detail' : 'landing')} className="inline-flex min-h-11 items-center text-sm underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300">← Back</button>
          <h2 className="text-base font-semibold">Access history</h2>
          <div className="flex flex-wrap gap-2">
            {(['all', 'success', 'refused'] as const).map((f) => (
              <button key={f} onClick={() => setAuditFilter(f)} aria-pressed={auditFilter === f}
                className={`rounded-lg border px-3 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300 ${auditFilter === f ? 'border-sky-400 bg-sky-900/50' : 'border-slate-600'}`}>
                {f === 'all' ? 'All' : f === 'success' ? 'Succeeded' : 'Refused'}
              </button>
            ))}
          </div>
          {/* Cards, not a wide table — usable at 375px without horizontal scroll. */}
          <ul className="space-y-2">
            {(audit ?? []).filter((e) => auditFilter === 'all' || e.outcome === auditFilter).map((e) => (
              <li key={e.id} className="rounded-lg border border-slate-700 bg-slate-900 p-3 text-sm">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  {/* Outcome carries a glyph + word, never colour alone. */}
                  <span className={e.outcome === 'success' ? 'text-emerald-300' : 'text-rose-300'}>
                    {e.outcome === 'success' ? '✓ Succeeded' : e.outcome === 'refused' ? '✕ Refused' : '! Error'}
                  </span>
                  <span className="min-w-0 flex-1 break-words font-medium">{e.operation}</span>
                </div>
                <p className="mt-1 break-words text-xs text-slate-400">{e.reason}</p>
                <p className="mt-1 break-all text-[11px] text-slate-500">
                  {e.at} · actor …{e.actorOid.slice(-6)} · target {e.targetOid ? `…${e.targetOid.slice(-6)}` : '—'} · {e.source} · ref {e.correlationId}
                  {e.elevatedAcknowledged === true ? ' · elevated acknowledged' : ''}
                </p>
                {e.previousRoles || e.resultingRoles ? (
                  <p className="mt-1 break-words text-[11px] text-slate-500">
                    {(e.previousRoles ?? []).join(', ') || 'none'} → {(e.resultingRoles ?? []).join(', ') || 'none'}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          {audit && audit.length === 0 ? <p className="text-sm text-slate-400">No access changes recorded yet.</p> : null}
        </section>
      ) : null}
    </div>
  );
}
