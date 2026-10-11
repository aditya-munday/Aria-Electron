export type CaptureMode =
  | { readonly kind: 'idle' }
  | { readonly kind: 'push_to_talk'; readonly mode: 'hold' | 'toggle' }
  | { readonly kind: 'wake_word'; readonly phrase: string };

export const IDLE_CAPTURE: CaptureMode = { kind: 'idle' };

export interface MuteStateView {
  readonly muted: boolean;
  readonly mode: CaptureMode;
}

function normalize(mode: CaptureMode): CaptureMode {
  return mode;
}

function sameMode(a: CaptureMode, b: CaptureMode): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'push_to_talk' && b.kind === 'push_to_talk') return a.mode === b.mode;
  if (a.kind === 'wake_word' && b.kind === 'wake_word') return a.phrase === b.phrase;
  return true;
}

/**
 * The microphone mute control. While muted it refuses every capture activation
 * (push-to-talk, wake word) locally, before any device is opened, so no input
 * reaches the runtime. Unmuting restores the exact prior mode. The muted flag is
 * a persisted value the controller is constructed with, so the state survives a
 * window reopen.
 */
export class MuteController {
  private muted: boolean;
  private mode: CaptureMode;

  constructor(options: { readonly muted: boolean; readonly mode?: CaptureMode } = { muted: false }) {
    this.muted = options.muted;
    this.mode = normalize(options.mode ?? IDLE_CAPTURE);
  }

  isMuted(): boolean {
    return this.muted;
  }

  /** The mode capture would run in were it not muted. */
  captureMode(): CaptureMode {
    return this.mode;
  }

  view(): MuteStateView {
    return { muted: this.muted, mode: this.mode };
  }

  mute(): void {
    this.muted = true;
  }

  unmute(): void {
    this.muted = false;
  }

  /** Record the mode the user activated. It is restored verbatim on unmute. */
  rememberMode(mode: CaptureMode): void {
    this.mode = normalize(mode);
  }

  /**
   * Whether a capture activation of `mode` may open the microphone right now.
   * A muted control refuses it, and the refused mode is not remembered — the
   * prior mode is what unmuting restores.
   */
  mayCapture(mode: CaptureMode): boolean {
    if (this.muted) return false;
    if (!sameMode(this.mode, mode)) this.mode = normalize(mode);
    return true;
  }
}
