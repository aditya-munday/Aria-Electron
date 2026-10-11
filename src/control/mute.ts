export type CaptureMode =
  | { readonly kind: 'idle' }
  | { readonly kind: 'push_to_talk'; readonly mode: 'hold' | 'toggle' }
  | { readonly kind: 'wake_word'; readonly phrase: string };

export const IDLE_CAPTURE: CaptureMode = { kind: 'idle' };

export interface MuteStateView {
  readonly muted: boolean;
  readonly mode: CaptureMode;
}

function sameMode(a: CaptureMode, b: CaptureMode): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'push_to_talk' && b.kind === 'push_to_talk') return a.mode === b.mode;
  if (a.kind === 'wake_word' && b.kind === 'wake_word') return a.phrase === b.phrase;
  return true;
}

export class MuteController {
  private muted: boolean;
  private mode: CaptureMode;

  constructor(options: { readonly muted: boolean; readonly mode?: CaptureMode } = { muted: false }) {
    this.muted = options.muted;
    this.mode = options.mode ?? IDLE_CAPTURE;
  }

  isMuted(): boolean {
    return this.muted;
  }

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

  rememberMode(mode: CaptureMode): void {
    this.mode = mode;
  }

  mayCapture(mode: CaptureMode): boolean {
    if (this.muted) return false;
    if (!sameMode(this.mode, mode)) this.mode = mode;
    return true;
  }
}
