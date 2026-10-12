import type { VoiceEvent } from '../voice/events.js';

export interface OrbDismissalDelays {
  readonly afterPlaybackMs: number;
  readonly afterResponseMs: number;
  readonly afterCancelledMs: number;
}

export const DEFAULT_ORB_DISMISSAL: OrbDismissalDelays = {
  afterPlaybackMs: 2500,
  afterResponseMs: 4500,
  afterCancelledMs: 6000,
};

export interface OrbDismissalVoice {
  on(listener: (event: VoiceEvent) => void): () => void;
}

export interface OrbDismissalDeps {
  readonly voice: OrbDismissalVoice;
  readonly hide: () => void;
  readonly isVisible: () => boolean;
  readonly delays?: Partial<OrbDismissalDelays>;
  readonly now?: () => number;
  readonly setTimer?: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

const BUSY_STATES: ReadonlySet<string> = new Set([
  'capturing',
  'transcribing',
  'thinking',
  'speaking',
]);

export class OrbDismissal {
  private readonly voice: OrbDismissalVoice;
  private readonly hide: () => void;
  private readonly isVisible: () => boolean;
  private readonly delays: OrbDismissalDelays;
  private readonly now: () => number;
  private readonly setTimer: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  private unsubscribe: (() => void) | undefined;
  private handle: ReturnType<typeof setTimeout> | undefined;
  private deadline: number | undefined;

  constructor(deps: OrbDismissalDeps) {
    this.voice = deps.voice;
    this.hide = deps.hide;
    this.isVisible = deps.isVisible;
    this.delays = { ...DEFAULT_ORB_DISMISSAL, ...deps.delays };
    this.now = deps.now ?? ((): number => Date.now());
    this.setTimer = deps.setTimer ?? ((handler, ms) => setTimeout(handler, ms));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle));
  }

  start(): void {
    if (this.unsubscribe !== undefined) return;
    this.unsubscribe = this.voice.on((event) => this.onEvent(event));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.cancel();
  }

  private cancel(): void {
    if (this.handle !== undefined) this.clearTimer(this.handle);
    this.handle = undefined;
    this.deadline = undefined;
  }

  private schedule(ms: number): void {
    const deadline = this.now() + ms;
    if (this.handle !== undefined && this.deadline !== undefined && this.deadline <= deadline) return;
    this.cancel();
    this.deadline = deadline;
    this.handle = this.setTimer(() => {
      this.handle = undefined;
      this.deadline = undefined;
      if (this.isVisible()) this.hide();
    }, ms);
  }

  private onEvent(event: VoiceEvent): void {
    switch (event.type) {
      case 'session.started':
      case 'capture.started':
      case 'speech.start':
      case 'response.delta':
      case 'synthesis.started':
      case 'playback.started':
        this.cancel();
        return;
      case 'playback.finished':
        this.schedule(this.delays.afterPlaybackMs);
        return;
      case 'response':
      case 'session.failed':
        this.schedule(this.delays.afterResponseMs);
        return;
      case 'session.cancelled':
      case 'utterance.rejected':
        this.schedule(this.delays.afterCancelledMs);
        return;
      case 'transcript':
        if (event.final && event.text.trim() === '') this.schedule(this.delays.afterCancelledMs);
        return;
      case 'session.state':
        if (BUSY_STATES.has(event.state)) {
          this.cancel();
        } else {
          this.schedule(this.delays.afterCancelledMs);
        }
        return;
      default:
        return;
    }
  }
}

export function createOrbDismissal(deps: OrbDismissalDeps): OrbDismissal {
  return new OrbDismissal(deps);
}
