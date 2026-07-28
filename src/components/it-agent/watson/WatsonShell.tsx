'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { WatsonParticles, caseStateToParticleState } from './WatsonParticles';
import { createMockTextToSpeech } from './voice-seam';

interface EmployeeCase {
  caseId: string; shortId: string; state: string; problem: string; platform: string;
  messages: { id: string; role: string; text: string }[];
  attachments: { id: string; name: string; kind: string }[];
  likelyCause: string | null; confidence: string | null;
  proposedSolution: { title: string; explanation: string; expectedInterruption: string } | null;
  estimate: { label: string; responseLabel?: string } | null;
  approval: { required: boolean; level: string; state: string };
  verification: { employeeChoice?: string };
  escalated: boolean; employeeReport: unknown;
}

export function WatsonShell() {
  const [c, setC] = useState<EmployeeCase | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [amp, setAmp] = useState(0);
  const [pending, setPending] = useState<{ name: string; url: string; type: string; size: number } | null>(null);
  const ttsRef = useRef(createMockTextToSpeech());

  useEffect(() => { api<EmployeeCase | null>('/api/it-agent/watson').then((r) => { if (r.ok) setC(r.data); }); }, []);

  function speakLatest(next: EmployeeCase | null) {
    const last = next?.messages.filter((m) => m.role === 'watson').slice(-1)[0];
    if (!last) return;
    setSpeaking(true);
    ttsRef.current.speak(last.text, { onAmplitude: setAmp, onEnd: () => { setSpeaking(false); setAmp(0); } });
  }

  async function post(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    const r = await api<EmployeeCase>('/api/it-agent/watson', { method: 'POST', body: JSON.stringify({ action, caseId: c?.caseId, ...extra }) });
    setBusy(false);
    if (r.ok) { setC(r.data); speakLatest(r.data); }
    return r;
  }

  // Approve, then run ONLY if approval actually granted (never chain past an
  // escalation or a non-granted state — one approval, one action).
  async function approveAndRun() {
    const r = await post('approve');
    if (r.ok && r.data.state === 'technician_working') await post('run');
  }

  // A finished case is immutable. Typing after resolution opens a NEW case
  // rather than appending to the resolved transcript.
  const isFinished = c?.state === 'resolved' || c?.state === 'closed' || c?.state === 'escalated';

  async function send() {
    const t = text.trim();
    if (!t) return;
    setText('');
    if (!c || isFinished) await post('start', { text: t });
    else await post('message', { text: t });
  }

  // Explicit "Start a new issue": clears the local case so the composer is
  // unmistakably starting fresh.
  function startNewIssue() {
    setC(null);
    setText('');
  }

  const particleState = caseStateToParticleState(c?.state, { listening, speaking });
  const showApproval = c?.approval.state === 'requested';
  const showVerify = c?.state === 'waiting_for_verification';

  return (
    <div className="mx-auto max-w-2xl space-y-5 rounded-3xl bg-slate-900 p-6 text-slate-100">
      <div className="flex flex-col items-center">
        <WatsonParticles state={particleState} amplitude={amp} />
        {!c ? <h1 className="mt-3 text-xl font-semibold text-slate-100">How can I help?</h1> : null}
        <p className="mt-2 rounded-full bg-slate-800 px-3 py-1 text-xs text-slate-300" role="note">
          Pilot — Watson simulates diagnostics and repairs. Nothing is changed without your approval.
        </p>
      </div>

      {/* Transcript — every spoken response is also shown as text. */}
      {c ? (
        <div className="space-y-2" aria-label="Conversation transcript">
          {c.messages.map((m) => (
            <div key={m.id} className={`rounded-2xl px-4 py-2 text-sm ${m.role === 'watson' ? 'bg-slate-800 text-slate-100' : 'ml-auto max-w-[85%] bg-sky-700 text-white'}`}>
              {m.text}
            </div>
          ))}
        </div>
      ) : null}

      {/* Diagnosis / estimate summary */}
      {c?.proposedSolution ? (
        <div className="rounded-2xl border border-slate-700 bg-slate-800 p-4 text-sm">
          <div className="font-semibold text-slate-100">{c.proposedSolution.title}</div>
          <p className="mt-1 text-slate-300">{c.proposedSolution.explanation}</p>
          <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-400">
            {c.confidence ? <span>Confidence: {c.confidence}</span> : null}
            {c.estimate ? <span>Estimated time: {c.estimate.label}</span> : null}
            <span>Interruption: {c.proposedSolution.expectedInterruption}</span>
          </div>
        </div>
      ) : null}

      {/* Approval controls — consequential actions always have a visible control. */}
      {showApproval ? (
        <div className="flex flex-wrap gap-2">
          <button disabled={busy} onClick={approveAndRun} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300">Approve</button>
          <button disabled={busy} onClick={() => post('decline')} className="rounded-lg bg-slate-700 px-4 py-2 text-sm text-slate-100">Not now</button>
          <button disabled={busy} onClick={() => { setText('I have a question: '); }} className="rounded-lg bg-slate-700 px-4 py-2 text-sm text-slate-100">Ask a question</button>
          <button disabled={busy} onClick={() => post('technician')} className="rounded-lg bg-slate-700 px-4 py-2 text-sm text-slate-100">Request a technician</button>
        </div>
      ) : null}

      {/* Verification controls */}
      {showVerify ? (
        <div className="flex flex-wrap gap-2">
          <button disabled={busy} onClick={() => post('verify', { choice: 'works' })} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white">Yes, it works</button>
          <button disabled={busy} onClick={() => post('verify', { choice: 'still_broken' })} className="rounded-lg bg-slate-700 px-4 py-2 text-sm text-slate-100">No, still broken</button>
          <button disabled={busy} onClick={() => post('verify', { choice: 'partial' })} className="rounded-lg bg-slate-700 px-4 py-2 text-sm text-slate-100">Partially working</button>
          <button disabled={busy} onClick={() => post('verify', { choice: 'unsure' })} className="rounded-lg bg-slate-700 px-4 py-2 text-sm text-slate-100">I&apos;m not sure</button>
        </div>
      ) : null}

      {/* Attachment preview + remove-before-submit */}
      {pending ? (
        <div className="flex items-center gap-3 rounded-lg border border-slate-700 bg-slate-800 p-2 text-xs text-slate-200">
          <img src={pending.url} alt="attachment preview" className="h-12 w-12 rounded object-cover" />
          <span className="flex-1 truncate">{pending.name}</span>
          <button onClick={() => { URL.revokeObjectURL(pending.url); setPending(null); }} className="text-rose-300 underline">Remove</button>
          <button disabled={busy || !c} onClick={async () => { await post('attach', { attachment: { kind: 'screenshot', name: pending.name, contentType: pending.type, sizeBytes: pending.size } }); URL.revokeObjectURL(pending.url); setPending(null); }} className="text-sky-300 underline">Attach</button>
        </div>
      ) : null}

      {isFinished ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-slate-700 bg-slate-800 p-3 text-sm text-slate-200">
          <span className="min-w-0 flex-1">This issue is finished. Anything new will open a fresh issue.</span>
          <button
            onClick={startNewIssue}
            className="rounded-lg bg-sky-700 px-3 py-2 text-sm font-medium text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300"
          >Start a new issue</button>
        </div>
      ) : null}
      {/* Input row: mic (mock push-to-talk), text, screenshot */}
      <div className="flex items-center gap-2">
        <button
          aria-pressed={listening}
          aria-label={listening ? 'Listening — release to stop (mock)' : 'Push to talk (mock)'}
          onMouseDown={() => setListening(true)}
          onMouseUp={() => setListening(false)}
          onMouseLeave={() => setListening(false)}
          onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setListening(true); } }}
          onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') setListening(false); }}
          onBlur={() => setListening(false)}
          title="Push to talk (mock)"
          className={`rounded-full px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 ${listening ? 'bg-sky-600 text-white' : 'bg-slate-700 text-slate-100'}`}
        >🎤</button>
        <input
          value={text}
          aria-label="Describe your problem"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
          placeholder="Describe your problem…"
          className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
        />
        <label
          role="button"
          tabIndex={0}
          aria-label="Attach a screenshot"
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.querySelector('input')?.click(); } }}
          className="cursor-pointer rounded-full bg-slate-700 px-3 py-2 text-sm text-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
          title="Attach a screenshot"
        >
          📎
          <input type="file" accept="image/*" className="hidden" onChange={(e) => {
            const f = e.target.files?.[0]; if (!f) return;
            setPending({ name: f.name, url: URL.createObjectURL(f), type: f.type, size: f.size });
            e.currentTarget.value = '';
          }} />
        </label>
        <button disabled={busy} onClick={send} className="rounded-lg bg-sky-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300">Send</button>
      </div>

      {c && speaking ? (
        <button onClick={() => { ttsRef.current.speak('', {}); setSpeaking(false); setAmp(0); }} className="text-xs text-slate-400 underline">Stop speaking</button>
      ) : null}

      <p className="text-center text-xs text-slate-400">Watson makes no changes without your approval. Microphone audio is never stored — only the text of your conversation.</p>
    </div>
  );
}
