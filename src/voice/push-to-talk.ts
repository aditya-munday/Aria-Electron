/**
 * Push-to-talk.
 *
 * Push-to-talk is a primary activation method, not a variation of wake-word
 * activation. Pressing the control begins capture immediately; the controller
 * never consults the wake-word detector and never requires its model to be
 * available.
 *
 * Two modes are supported and their semantics are never mixed:
 *   - `hold`: capture runs while the control is held; releasing finalizes the
 *     utterance immediately.
 *   - `toggle`: a press starts capture; the next press finalizes it.
 *
 * The controller decides *when* the utterance ends (release, or the max-duration
 * cap); it does not do the audio processing. It emits intent transitions that
 * the voice session turns into capture start/stop.
 */

import { VoiceError } from './errors.js';

export type PushToTalkMode = 'hold' | 'toggle';

export interface PushToTalkConfig {
  readonly enabled: boolean;
  readonly mode: PushToTalkMode;
  /** A press shorter than this is treated as accidental and does not submit. */
  readonly minPressMs: number;
  /** Capture is finalized automatically at this duration, in ms. */
  readonly maxUtteranceMs: number;
}

export const DEFAULT_PUSH_TO_TALK: PushToTalkConfig = {
  enabled: true,
  mode: 'hold',
  minPressMs: 200,
  maxUtteranceMs: 60_000,
};

export type PushToTalkIntent =
  | { readonly kind: 'begin' }
  | { readonly kind: 'finalize'; readonly reason: 'released' | 'max_duration' }
  | { readonly kind: 'cancel'; readonly reason: 'too_short' | 'released_before_start' };

export interface PushToTalkControllerDeps {
  readonly config: PushToTalkConfig;
  /** Injected clock, so the timing behaviour is deterministic in tests. */
  readonly now: () => number;
}

export class PushToTalkController {
  private readonly config: PushToTalkConfig;
  private readonly now: () => number;
  private capturing = false;
  private pressStartedMs = 0;

  constructor(deps: PushToTalkControllerDeps) {
    this.config = deps.config;
    this.now = deps.now;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  mode(): PushToTalkMode {
    return this.config.mode;
  }

  isCapturing(): boolean {
    return this.capturing;
  }

  /**
   * Handle a control press. In both modes this begins capture. A press while
   * already capturing in `toggle` mode finalizes; in `hold` mode a duplicate
   * press is ignored (the control is already down).
   */
  press(): PushToTalkIntent[] {
    if (!this.config.enabled) return [];
    if (this.capturing) {
      if (this.config.mode === 'toggle') {
        const elapsed = this.now() - this.pressStartedMs;
        this.capturing = false;
        return [this.finalizeIntent(elapsed)];
      }
      return [];
    }
    this.capturing = true;
    this.pressStartedMs = this.now();
    return [{ kind: 'begin' }];
  }

  /**
   * Handle a control release. Only meaningful in `hold` mode: releasing finalizes
   * the utterance (or cancels an accidental tap). In `toggle` mode a release is
   * ignored — the capture continues until the next press.
   */
  release(): PushToTalkIntent[] {
    if (!this.config.enabled) return [];
    if (!this.capturing) return [];
    if (this.config.mode !== 'hold') return [];
    const elapsed = this.now() - this.pressStartedMs;
    this.capturing = false;
    return [this.finalizeIntent(elapsed)];
  }

  /** Whether the current press has exceeded the maximum utterance duration. */
  pollMaxDuration(): PushToTalkIntent[] {
    if (!this.capturing) return [];
    if (this.now() - this.pressStartedMs < this.config.maxUtteranceMs) return [];
    this.capturing = false;
    return [{ kind: 'finalize', reason: 'max_duration' }];
  }

  /** Force capture off (session teardown, device loss). */
  abort(): void {
    this.capturing = false;
  }

  private finalizeIntent(elapsedMs: number): PushToTalkIntent {
    if (elapsedMs < this.config.minPressMs) {
      return { kind: 'cancel', reason: 'too_short' };
    }
    return { kind: 'finalize', reason: 'released' };
  }
}

export function createPushToTalk(deps: PushToTalkControllerDeps): PushToTalkController {
  const { config } = deps;
  if (config.enabled) {
    if (!(config.minPressMs >= 0)) {
      throw new VoiceError('invalid_configuration', 'Push-to-talk min press must be >= 0 ms.');
    }
    if (!(config.maxUtteranceMs > config.minPressMs)) {
      throw new VoiceError(
        'invalid_configuration',
        'Push-to-talk max utterance must exceed the min press.',
      );
    }
  }
  return new PushToTalkController(deps);
}
