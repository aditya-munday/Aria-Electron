/**
 * Local audio playback.
 *
 * Playback is behind a {@link Speaker} abstraction, like capture is behind
 * {@link Microphone}. A generated audio response is not proof the user heard
 * it: synthesis success and playback success are tracked separately, and this
 * layer is where "played" is actually established.
 *
 * An interruption must stop playback promptly without waiting for the current
 * buffer to finish naturally, so `stop()` uses a cancellation token rather than
 * draining the queue.
 */

import { VoiceError } from './errors.js';

export interface Speaker {
  /**
   * Play a whole PCM buffer. Resolves when playback finishes naturally, rejects
   * with a `cancelled` error when interrupted, and rejects with `playback_failed`
   * when the device cannot play.
   */
  play(pcm: Int16Array, format: { sampleRate: number; channels: number }): Promise<void>;
  /** Interrupt any current playback promptly. Idempotent. */
  stop(): Promise<void>;
}

/** A deterministic speaker for tests: it plays only when `advance()` is called. */
export class ManualSpeaker implements Speaker {
  private pending:
    | {
        resolve: () => void;
        reject: (error: VoiceError) => void;
        pcm: Int16Array;
      }
    | undefined;
  private readonly played: Int16Array[] = [];

  async play(pcm: Int16Array): Promise<void> {
    if (this.pending !== undefined) {
      // A new play replaces the old: the old one is interrupted, never stacked.
      this.pending.reject(new VoiceError('cancelled', 'Playback was replaced.'));
      this.pending = undefined;
    }
    return new Promise<void>((resolve, reject) => {
      this.pending = { resolve, reject, pcm };
    });
  }

  async stop(): Promise<void> {
    if (this.pending !== undefined) {
      const { reject } = this.pending;
      this.pending = undefined;
      reject(new VoiceError('cancelled', 'Playback was interrupted.'));
    }
  }

  /** Finish the current playback naturally. */
  advance(): void {
    if (this.pending !== undefined) {
      const { resolve, pcm } = this.pending;
      this.pending = undefined;
      this.played.push(pcm);
      resolve();
    }
  }

  /** Fail the current playback as if the device were removed. */
  fail(message = 'The audio device was lost.'): void {
    if (this.pending !== undefined) {
      const { reject } = this.pending;
      this.pending = undefined;
      reject(new VoiceError('playback_failed', message));
    }
  }

  isPlaying(): boolean {
    return this.pending !== undefined;
  }

  playedBuffers(): readonly Int16Array[] {
    return this.played;
  }
}
