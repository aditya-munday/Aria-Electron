/**
 * The app's sound layer.
 *
 * Every cue is synthesised with the Web Audio API rather than shipped as an
 * audio file, so there is no binary to package, no network fetch and no CSP
 * exception (the `media-src`/`default-src 'none'` policy stays intact). Cues
 * are short, quiet and throttled; a user who has asked for reduced motion, or
 * who has muted the app, hears nothing at all.
 *
 * The layer is inert everywhere a real `AudioContext` is absent (jsdom, a
 * headless check), so importing it never breaks a render or a test.
 */

export type Cue = 'send' | 'receive' | 'notify' | 'start' | 'stop' | 'error' | 'toggle' | 'confirm';

interface Voice {
  readonly freq: number;
  readonly to: number;
  readonly dur: number;
  readonly type: OscillatorType;
  readonly gain: number;
  readonly delay?: number;
}

/** Each cue is one or two short tones; the shapes stay in the mid range. */
const CUES: Readonly<Record<Cue, readonly Voice[]>> = {
  send: [{ freq: 520, to: 780, dur: 0.12, type: 'sine', gain: 0.05 }],
  receive: [{ freq: 720, to: 480, dur: 0.16, type: 'sine', gain: 0.05 }],
  notify: [
    { freq: 660, to: 660, dur: 0.12, type: 'triangle', gain: 0.06 },
    { freq: 990, to: 990, dur: 0.16, type: 'triangle', gain: 0.06, delay: 0.1 },
  ],
  start: [
    { freq: 440, to: 660, dur: 0.1, type: 'sine', gain: 0.05 },
    { freq: 880, to: 880, dur: 0.14, type: 'sine', gain: 0.05, delay: 0.08 },
  ],
  stop: [{ freq: 380, to: 220, dur: 0.2, type: 'sawtooth', gain: 0.045 }],
  error: [
    { freq: 300, to: 300, dur: 0.16, type: 'square', gain: 0.04 },
    { freq: 240, to: 240, dur: 0.2, type: 'square', gain: 0.04, delay: 0.12 },
  ],
  toggle: [{ freq: 620, to: 620, dur: 0.06, type: 'sine', gain: 0.035 }],
  confirm: [{ freq: 700, to: 1040, dur: 0.14, type: 'sine', gain: 0.05 }],
};

const STORAGE_KEY = 'aria.sfx.muted';
const THROTTLE_MS = 45;

let context: AudioContext | undefined;
let muted: boolean | undefined;
let lastPlayedAt = 0;
let lastCue: Cue | undefined;

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function isMuted(): boolean {
  if (muted === undefined) {
    muted = storage()?.getItem(STORAGE_KEY) === '1';
  }
  return muted;
}

export function setMuted(next: boolean): void {
  muted = next;
  try {
    storage()?.setItem(STORAGE_KEY, next ? '1' : '0');
  } catch {
    // A read-only storage must not stop the app from remembering the choice.
  }
}

function reducedMotion(): boolean {
  if (typeof globalThis.matchMedia !== 'function') return false;
  return globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function audioContext(): AudioContext | undefined {
  if (context !== undefined) return context;
  const Ctor =
    (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (Ctor === undefined) return undefined;
  try {
    context = new Ctor();
  } catch {
    return undefined;
  }
  return context;
}

/** Play one cue, unless muted, reduced-motion, throttled, or silent in this host. */
export function playCue(cue: Cue): void {
  if (isMuted() || reducedMotion()) return;
  const now = Date.now();
  // A held key or a burst of state changes must not stack into a rattle.
  if (cue === lastCue && now - lastPlayedAt < THROTTLE_MS) return;
  lastPlayedAt = now;
  lastCue = cue;

  const ctx = audioContext();
  if (ctx === undefined) return;
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);

  const start = ctx.currentTime;
  for (const voice of CUES[cue]) {
    const at = start + (voice.delay ?? 0);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = voice.type;
    osc.frequency.setValueAtTime(voice.freq, at);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, voice.to), at + voice.dur);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(voice.gain, at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + voice.dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + voice.dur + 0.02);
  }
}

const CUE_EVENT = 'aria:cue';

/** Ask the sound layer to play a cue from anywhere a Document is in reach. */
export function emitCue(doc: Document, cue: Cue): void {
  doc.dispatchEvent(new CustomEvent(CUE_EVENT, { detail: cue }));
}

function cueOf(value: unknown): Cue | undefined {
  return typeof value === 'string' && Object.hasOwn(CUES, value) ? (value as Cue) : undefined;
}

/**
 * Wire the ambient cues that every surface shares: a click or keypress on a
 * button, tab or switch reads as a small toggle, and a submit (Enter in a text
 * field, or a form's submit) reads as send. Surfaces emit their own semantic
 * cues (notify, start, stop, error) through {@link emitCue}.
 */
export function attachCues(doc: Document): () => void {
  const onClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('button, [role="button"], .tab, .switch, a[href]') === null) return;
    playCue(target.closest('[data-cue="primary"]') !== null ? 'confirm' : 'toggle');
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    const target = event.target;
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
      playCue('send');
    }
  };
  const onCue = (event: Event): void => {
    const cue = cueOf((event as CustomEvent).detail);
    if (cue !== undefined) playCue(cue);
  };
  const onVisibility = (): void => {
    // A backgrounded window must not keep a context alive.
    if (doc.visibilityState === 'hidden' && context !== undefined) {
      void context.suspend().catch(() => undefined);
    }
  };

  doc.addEventListener('click', onClick, true);
  doc.addEventListener('keydown', onKeyDown, true);
  doc.addEventListener(CUE_EVENT, onCue);
  doc.addEventListener('visibilitychange', onVisibility);

  return () => {
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('keydown', onKeyDown, true);
    doc.removeEventListener(CUE_EVENT, onCue);
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}
