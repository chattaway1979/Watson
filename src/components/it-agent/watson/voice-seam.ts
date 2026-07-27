// ============================================================
// Watson — provider-neutral VOICE seam (client).
// ------------------------------------------------------------
// Narrow interfaces for speech-to-text, text-to-speech, playback lifecycle,
// interruption, and amplitude events (for particle animation). V1 ships only a
// DETERMINISTIC MOCK: no real microphone, no external speech provider, no audio
// assets, no network. Every spoken response is also rendered as text elsewhere.
// ============================================================

// A voice profile DESCRIPTOR only — direction, never a celebrity or an audio
// asset. Used to label the mock; a real provider would map this to its voice.
export interface VoiceProfile {
  id: string;
  displayName: string;
  language: string;
  gender: 'male' | 'female' | 'neutral';
  register: 'deep' | 'medium' | 'high';
  cadence: 'measured' | 'brisk';
  notes: string;
}

export const WATSON_VOICE: VoiceProfile = {
  id: 'watson-en-gb-mature-male-v1',
  displayName: 'Watson (British, mature male)',
  language: 'en-GB',
  gender: 'male',
  register: 'deep',
  cadence: 'measured',
  notes: 'Warm authority, calm technical confidence. Direction only — no impersonation, no audio asset in this build.'
};

export interface SpeechToText {
  readonly id: string;
  start(): void;
  stop(): Promise<string>;      // resolves the (mock) transcript
  readonly listening: boolean;
}

export interface TextToSpeech {
  readonly id: string;
  readonly profile: VoiceProfile;
  // Begin "speaking" text; onAmplitude drives the lower particle region; onEnd
  // fires when playback completes. Returns a handle to stop/interrupt.
  speak(text: string, cb?: { onAmplitude?: (level: number) => void; onEnd?: () => void }): SpeechHandle;
  readonly speaking: boolean;
}
export interface SpeechHandle {
  stop(): void;                 // immediate interruption
}

// ------------------------------------------------------------
// Deterministic mocks. No timers are required for correctness; a caller may
// advance them manually for animation. Nothing is persisted; no network.
// ------------------------------------------------------------
export function createMockSpeechToText(script: string): SpeechToText {
  let _listening = false;
  return {
    id: 'mock-stt',
    get listening() { return _listening; },
    start() { _listening = true; },
    async stop() { _listening = false; return script; }
  };
}

export function createMockTextToSpeech(): TextToSpeech {
  let _speaking = false;
  return {
    id: 'mock-tts',
    profile: WATSON_VOICE,
    get speaking() { return _speaking; },
    speak(text, cb) {
      _speaking = true;
      // Deterministic amplitude "envelope" derived from text length — no audio.
      let stopped = false;
      const total = Math.min(text.length, 240);
      let i = 0;
      const tick = () => {
        if (stopped) return;
        if (i >= total) { _speaking = false; cb?.onEnd?.(); return; }
        cb?.onAmplitude?.(0.3 + 0.5 * Math.abs(Math.sin(i / 6)));
        i += 12;
        if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(tick);
        else { _speaking = false; cb?.onEnd?.(); } // non-browser (tests): resolve immediately
      };
      tick();
      return {
        stop() { stopped = true; _speaking = false; cb?.onAmplitude?.(0); }
      };
    }
  };
}
