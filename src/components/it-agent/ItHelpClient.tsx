'use client';
import { useState } from 'react';
import Link from 'next/link';
import { WatsonAvatar } from './WatsonAvatar';
import { IssueCategoryCards } from './IssueCategoryCards';
import { MockModeBanner } from './MockModeBanner';
import { CategoryBadge, PriorityBadge, RiskBadge } from './Badges';
import { api } from './api';

interface DispositionedAction {
  actionKey: string; displayName: string; riskLevel: string; requiresApproval: boolean; rationale: string; disposition: string;
}
interface WatsonReply {
  message: string;
  triage: { diagnosis: { category: string; priority: string; confidence: number; summary: string }; plan: { steps: string[] } };
  actions: DispositionedAction[];
  articles: { slug: string; title: string; summary: string }[];
  safety: string;
}
interface ChatTurn { who: 'you' | 'watson'; text: string; reply?: WatsonReply; }

const DISPOSITION_LABEL: Record<string, string> = {
  recommended: 'Recommended',
  prepared: 'Prepared',
  approval_required: 'Approval required',
  mock_executable: 'Mock-executable',
  unavailable_live: 'Live disabled'
};

export function ItHelpClient() {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastReply, setLastReply] = useState<WatsonReply | null>(null);
  const [created, setCreated] = useState<{ shortId: string; id: string } | null>(null);

  async function send(text: string) {
    const msg = text.trim();
    if (!msg || busy) return;
    setBusy(true);
    setCreated(null);
    setTurns((t) => [...t, { who: 'you', text: msg }]);
    setInput('');
    const r = await api<WatsonReply>('/api/it-agent/triage', { method: 'POST', body: JSON.stringify({ text: msg }) });
    if (r.ok) {
      setLastReply(r.data);
      setTurns((t) => [...t, { who: 'watson', text: r.data.message, reply: r.data }]);
    } else {
      setTurns((t) => [...t, { who: 'watson', text: `Sorry — ${r.error}` }]);
    }
    setBusy(false);
  }

  async function createTicket() {
    if (!lastReply) return;
    setBusy(true);
    const lastYou = [...turns].reverse().find((t) => t.who === 'you')?.text ?? 'IT support request';
    const r = await api<{ shortId: string; id: string }>('/api/it-agent/tickets', {
      method: 'POST',
      body: JSON.stringify({
        subject: lastYou.slice(0, 70),
        description: turns.filter((t) => t.who === 'you').map((t) => t.text).join('\n'),
        category: lastReply.triage.diagnosis.category,
        priority: lastReply.triage.diagnosis.priority,
        runTriage: false
      })
    });
    if (r.ok) setCreated(r.data);
    setBusy(false);
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <section className="rounded-2xl border border-watson-line bg-white shadow-sm">
        <div className="flex items-center gap-3 rounded-t-2xl border-b border-watson-line bg-gradient-to-r from-watson-ink to-watson-slate px-4 py-3 text-white">
          <WatsonAvatar size={36} />
          <div>
            <div className="text-sm font-semibold">Watson</div>
            <div className="text-[11px] text-slate-300">Describe your IT problem in plain language</div>
          </div>
        </div>

        <div className="space-y-3 p-4">
          {turns.length === 0 && (
            <div className="rounded-xl bg-watson-bg p-4 text-sm text-watson-steel">
              <p className="mb-3 font-medium text-watson-ink">Hi, I&apos;m Watson. How can I help with your IT today?</p>
              <p className="mb-3 text-watson-mist">Pick a common issue or type your own below. I&apos;ll suggest fixes and can open a ticket — I never make risky changes without admin approval.</p>
              <IssueCategoryCards onPick={(p) => send(p)} />
            </div>
          )}

          {turns.map((t, i) => (
            <div key={i} className={`animate-in flex gap-2 ${t.who === 'you' ? 'justify-end' : ''}`}>
              {t.who === 'watson' && <div className="mt-1"><WatsonAvatar size={28} /></div>}
              <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${t.who === 'you' ? 'bg-watson-accent text-white' : 'bg-watson-bg text-watson-ink'}`}>
                <pre className="whitespace-pre-wrap font-sans">{t.text}</pre>
                {t.reply && (
                  <div className="mt-3 space-y-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <CategoryBadge category={t.reply.triage.diagnosis.category} />
                      <PriorityBadge priority={t.reply.triage.diagnosis.priority} />
                      <span className="text-[11px] text-watson-mist">confidence {(t.reply.triage.diagnosis.confidence * 100).toFixed(0)}%</span>
                    </div>

                    {t.reply.actions.length > 0 && (
                      <div>
                        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-watson-mist">Recommended actions</div>
                        <ul className="space-y-1">
                          {t.reply.actions.map((a) => (
                            <li key={a.actionKey} className="flex flex-wrap items-center gap-1.5 text-xs">
                              <RiskBadge risk={a.riskLevel} />
                              <span className="font-medium">{a.displayName}</span>
                              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">{DISPOSITION_LABEL[a.disposition] ?? a.disposition}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {t.reply.articles.length > 0 && (
                      <div>
                        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-watson-mist">Helpful articles</div>
                        <ul className="space-y-0.5">
                          {t.reply.articles.map((a) => (
                            <li key={a.slug}><Link className="text-xs text-watson-accent underline" href={`/it/knowledge/${a.slug}`}>{a.title}</Link></li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}

          {lastReply && !created && (
            <div className="rounded-xl border border-dashed border-watson-accent bg-blue-50 p-3 text-sm">
              <p className="mb-2 text-watson-steel">Still need help? I can open a ticket for the IT team.</p>
              <button onClick={createTicket} disabled={busy} className="btn rounded-lg bg-watson-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                Create ticket
              </button>
            </div>
          )}
          {created && (
            <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">
              ✅ Ticket <span className="font-semibold">{created.shortId}</span> created.{' '}
              <Link className="underline" href={`/it/tickets/${created.id}`}>View ticket</Link>
            </div>
          )}
        </div>

        <div className="border-t border-watson-line p-3">
          <form
            onSubmit={(e) => { e.preventDefault(); send(input); }}
            className="flex items-end gap-2"
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); } }}
              rows={1}
              placeholder="Type your IT issue…"
              className="min-h-[44px] flex-1 resize-none rounded-xl border border-watson-line px-3 py-2 text-sm focus:border-watson-accent focus:outline-none"
            />
            <button type="submit" disabled={busy || !input.trim()} className="btn rounded-xl bg-watson-ink px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
              {busy ? '…' : 'Send'}
            </button>
          </form>
        </div>
      </section>

      <aside className="space-y-3">
        <MockModeBanner />
        <div className="rounded-2xl border border-watson-line bg-white p-4 text-sm shadow-sm">
          <h3 className="mb-2 font-semibold text-watson-ink">What Watson can do</h3>
          <ul className="space-y-1.5 text-watson-steel">
            <li>• Classify your issue & suggest fixes</li>
            <li>• Point you to the right setup article</li>
            <li>• Open and track a support ticket</li>
            <li>• Prepare (not perform) admin actions</li>
            <li>• Escalate anything risky to a human</li>
          </ul>
          <p className="mt-3 text-xs text-watson-mist">Watson never resets passwords, changes accounts, or touches devices on its own. Those require human approval.</p>
        </div>
        <div className="rounded-2xl border border-watson-line bg-white p-4 text-sm shadow-sm">
          <Link href="/it/tickets" className="text-watson-accent underline">View my tickets →</Link>
        </div>
      </aside>
    </div>
  );
}
