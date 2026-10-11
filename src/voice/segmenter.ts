/**
 * Assembling one utterance into a bounded PCM payload.
 *
 * The assembler collects the frames the VAD (or push-to-talk) has marked as
 * belonging to the current utterance and turns them into the little-endian i16
 * PCM Aria submits. It enforces the bounds that keep a session honest and
 * bounded:
 *   - an empty capture is rejected before any request,
 *   - an utterance shorter than `minDurationMs` is treated as noise, not speech,
 *   - an utterance is capped at `maxDurationMs` so long speech cannot grow the
 *     buffer without limit.
 *
 * It does not decide *when* the utterance ends; that is the VAD's or the
 * push-to-talk controller's job. This keeps activation/utterance detection and
 * payload construction independent.
 */

import { MAX_PCM_BYTES, pcmDurationMs } from './audio-format.js';

export type UtteranceOutcome =
  | { readonly kind: 'ok'; readonly pcm: Int16Array; readonly durationMs: number }
  | { readonly kind: 'empty' }
  | { readonly kind: 'too_short'; readonly durationMs: number }
  | { readonly kind: 'too_long'; readonly durationMs: number };

export interface UtteranceAssemblerConfig {
  readonly sampleRate: number;
  readonly channels: number;
  /** Below this, the capture is not speech worth submitting. */
  readonly minDurationMs: number;
  /** At or above this, the utterance is closed and flagged over-long. */
  readonly maxDurationMs: number;
}

export const DEFAULT_MIN_UTTERANCE_MS = 200;

export class UtteranceAssembler {
  private readonly config: UtteranceAssemblerConfig;
  private readonly maxSamples: number;
  private readonly buffer: Float64Array;
  private sampleCount = 0;
  private overflowed = false;

  constructor(config: UtteranceAssemblerConfig) {
    this.config = config;
    const maxSamplesPerChannel = Math.floor((config.maxDurationMs / 1000) * config.sampleRate);
    this.maxSamples = maxSamplesPerChannel * config.channels;
    this.buffer = new Float64Array(this.maxSamples);
  }

  get durationMs(): number {
    const perChannel = this.sampleCount / this.config.channels;
    return (perChannel / this.config.sampleRate) * 1000;
  }

  get samples(): number {
    return this.sampleCount;
  }

  get isFull(): boolean {
    return this.sampleCount >= this.maxSamples;
  }

  /**
   * Append a frame. Once the buffer is full further frames are dropped (the
   * utterance is over-long) rather than growing memory. Returns `true` when the
   * frame fit, `false` when it was dropped.
   */
  push(frame: Float64Array): boolean {
    if (this.sampleCount >= this.maxSamples) {
      this.overflowed = true;
      return false;
    }
    const room = this.maxSamples - this.sampleCount;
    const take = Math.min(room, frame.length);
    this.buffer.set(frame.subarray(0, take), this.sampleCount);
    this.sampleCount += take;
    if (take < frame.length) this.overflowed = true;
    return take === frame.length;
  }

  /** Whether frames were dropped because the utterance exceeded the cap. */
  get overflow(): boolean {
    return this.overflowed;
  }

  /** Finish the utterance and produce the outcome (never throws on empty). */
  finish(): UtteranceOutcome {
    if (this.sampleCount === 0) return { kind: 'empty' };
    const durationMs = this.durationMs;
    if (this.overflowed) return { kind: 'too_long', durationMs };
    if (durationMs < this.config.minDurationMs) return { kind: 'too_short', durationMs };
    const pcm = toInt16(this.buffer.subarray(0, this.sampleCount));
    const bytes = pcm.byteLength;
    if (bytes > MAX_PCM_BYTES) {
      return { kind: 'too_long', durationMs: pcmDurationMs(bytes, this.config.sampleRate, this.config.channels) };
    }
    return { kind: 'ok', pcm, durationMs };
  }

  reset(): void {
    this.sampleCount = 0;
    this.overflowed = false;
  }
}

/**
 * Convert float samples in [-1, 1] to little-endian i16. Values outside the
 * range are clamped; the platform is little-endian, so the typed-array bytes are
 * already the wire order Aria's contract requires.
 */
export function toInt16(samples: Float64Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i] as number;
    const clamped = s > 1 ? 1 : s < -1 ? -1 : s;
    out[i] = Math.round(clamped * 32767);
  }
  return out;
}

/** Base64-encode raw bytes (the Aria audio payload encoding). */
export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}
