'use client';
import { useEffect, useRef } from 'react';

export type ParticleState =
  | 'ready' | 'listening' | 'understanding' | 'investigating' | 'explaining'
  | 'waiting_for_permission' | 'working' | 'verifying' | 'resolved' | 'escalated' | 'unavailable';

// State is NEVER conveyed by animation alone — every state has a text label.
export const PARTICLE_LABELS: Record<ParticleState, string> = {
  ready: 'Ready',
  listening: 'Listening…',
  understanding: 'Understanding…',
  investigating: 'Investigating…',
  explaining: 'Explaining',
  waiting_for_permission: 'Waiting for your permission',
  working: 'Working…',
  verifying: 'Checking the result…',
  resolved: 'Resolved',
  escalated: 'Passed to a technician',
  unavailable: 'Temporarily unavailable'
};

// Map a case state (+ interaction flags) to a particle state. Pure + testable.
export function caseStateToParticleState(
  caseState: string | null | undefined,
  flags: { listening?: boolean; speaking?: boolean } = {}
): ParticleState {
  if (flags.listening) return 'listening';
  if (flags.speaking) return 'explaining';
  switch (caseState) {
    case 'investigating': return 'investigating';
    case 'waiting_for_employee': return 'understanding';
    case 'waiting_for_approval': return 'waiting_for_permission';
    case 'technician_working': return 'working';
    case 'waiting_for_verification': return 'verifying';
    case 'resolved': return 'resolved';
    case 'closed': return 'resolved';
    case 'escalated': return 'escalated';
    case 'assigned': return 'escalated';
    default: return 'ready';
  }
}

interface Cfg { spread: number; speed: number; inward: number; dim: number }
const STATE_CFG: Record<ParticleState, Cfg> = {
  ready: { spread: 1, speed: 0.4, inward: 0, dim: 1 },
  listening: { spread: 0.7, speed: 0.8, inward: 0.4, dim: 1 },
  understanding: { spread: 0.85, speed: 0.5, inward: 0.2, dim: 1 },
  investigating: { spread: 1.1, speed: 1.4, inward: 0, dim: 1 },
  explaining: { spread: 0.95, speed: 0.6, inward: 0.1, dim: 1 },
  waiting_for_permission: { spread: 0.9, speed: 0.35, inward: 0.15, dim: 1 },
  working: { spread: 1.05, speed: 1.2, inward: 0, dim: 1 },
  verifying: { spread: 0.9, speed: 0.6, inward: 0.2, dim: 1 },
  resolved: { spread: 0.8, speed: 0.5, inward: 0.3, dim: 1 },
  escalated: { spread: 0.9, speed: 0.3, inward: 0.1, dim: 1 },
  unavailable: { spread: 1, speed: 0.15, inward: 0, dim: 0.35 }
};

export function WatsonParticles({ state, amplitude = 0 }: { state: ParticleState; amplitude?: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef(state);
  const ampRef = useRef(amplitude);
  // Keep the animation loop's live values in sync WITHOUT touching refs during
  // render (which React forbids).
  useEffect(() => { stateRef.current = state; ampRef.current = amplitude; }, [state, amplitude]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduced = typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false;

    const DPR = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
    const size = 220;
    canvas.width = size * DPR; canvas.height = size * DPR;
    ctx.scale(DPR, DPR);
    const cx = size / 2, cy = size / 2;

    const N = reduced ? 90 : 140;
    const parts = Array.from({ length: N }, (_, i) => {
      const a = (i / N) * Math.PI * 2;
      const r = 55 + (i % 7) * 6;
      return { a, r, x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, ox: Math.cos(a) * r, oy: Math.sin(a) * r };
    });

    function draw(ctx: CanvasRenderingContext2D, t: number) {
      const cfg = STATE_CFG[stateRef.current];
      ctx.clearRect(0, 0, size, size);
      const breathe = reduced ? 0 : Math.sin(t / 900) * 3;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const inward = 1 - cfg.inward * 0.4;
        let tx = cx + p.ox * cfg.spread * inward;
        let ty = cy + p.oy * cfg.spread * inward + breathe;
        // Lower region responds to speech amplitude.
        if (p.oy > 0) ty += (ampRef.current || 0) * 14 * (p.oy / 60);
        if (!reduced) {
          const jitter = cfg.speed * 1.6;
          tx += Math.sin(t / 500 + p.a * 3) * jitter;
          ty += Math.cos(t / 480 + p.a * 3) * jitter;
        }
        p.x += (tx - p.x) * 0.08;
        p.y += (ty - p.y) * 0.08;
        const blue = stateRef.current === 'escalated' ? 200 : stateRef.current === 'resolved' ? 180 : 235;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${180},${205},${blue},${0.55 * cfg.dim})`;
        ctx.fill();
      }
    }

    let raf = 0;
    if (reduced) {
      draw(ctx, 0); // single static frame
    } else {
      const loop = (t: number) => { draw(ctx, t); raf = requestAnimationFrame(loop); };
      raf = requestAnimationFrame(loop);
    }
    return () => { if (raf) cancelAnimationFrame(raf); };
  }, []);

  return (
    <div className="flex flex-col items-center gap-2" role="img" aria-label={`Watson status: ${PARTICLE_LABELS[state]}`}>
      <canvas ref={canvasRef} style={{ width: 220, height: 220 }} className="rounded-full bg-slate-950" />
      <div className="text-sm font-medium text-slate-200" aria-live="polite">{PARTICLE_LABELS[state]}</div>
    </div>
  );
}
