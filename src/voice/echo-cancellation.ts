/**
 * Local acoustic echo cancellation.
 *
 * While Aria speaks, its own output re-enters the microphone as echo. Left
 * uncancelled, that echo stories the wake-word detector and, mid-turn, the
 * transcriber. This module removes it using only the far-end reference — the
 * PCM Aria is playing — never the network.
 *
 * It is a cascade of the two stages a practical linear canceller needs:
 *   1. A normalized-least-mean-squares (NLMS) adaptive FIR filter that models
 *      the echo path and subtracts its estimate from the microphone signal. The
 *      step is normalized by reference energy so it converges without knowing
 *      the echo amplitude, and it is frozen during double-talk so the near-end
 *      speaker cannot corrupt the estimate of the echo path.
 *   2. A residual-echo suppressor that follows the linear stage. Linear
 *      cancellation alone cannot remove the non-linear part of the echo; this
 *      attenuates what is left, but only while the reference is active and the
 *      near-end is quiet, so a genuine utterance is never gated.
 *
 * Double-talk is detected with the Geigel rule: the near-end is considered
 * present when the microphone envelope exceeds the loudest recent reference
 * sample by a margin, which is the case a barge-in should pass and steady echo
 * should not.
 *
 * A failure to process is observable and follows a defined fallback (bypass), so
 * a canceller fault cannot stall a session.
 */

import { VoiceError } from './errors.js';

export interface EchoCancellationConfig {
  readonly enabled: boolean;
  /** Length of the adaptive filter (the modelled echo tail), in ms. */
  readonly filterLengthMs: number;
  /** NLMS step size in (0, 1]; larger converges faster, less stable. */
  readonly stepSize: number;
  /** Geigel margin in dB: how far the mic must exceed recent reference. */
  readonly doubleTalkMarginDb: number;
  /** The most the residual suppressor attenuates, in dB (a negative number). */
  readonly suppressionDb: number;
  /** The longest reference lag the filter models, in ms. */
  readonly maxLagMs: number;
}

export const DEFAULT_ECHO_CANCELLATION: EchoCancellationConfig = {
  enabled: true,
  filterLengthMs: 128,
  stepSize: 0.25,
  doubleTalkMarginDb: 6,
  suppressionDb: -24,
  maxLagMs: 24,
};

export interface EchoCancellationStats {
  readonly active: boolean;
  /** Echo-return loss enhancement so far, in dB (higher is better). */
  readonly erleDb: number;
  /** The most recent double-talk decision. */
  readonly doubleTalk: boolean;
  readonly lastError?: string;
}

const EPSILON = 1e-9;

function toDb(amplitude: number): number {
  return 10 * Math.log10(Math.max(amplitude, EPSILON));
}

/**
 * One canceller is bound to one microphone stream. The far-end reference is fed
 * separately; the canceller aligns it to the microphone by a single sample clock.
 */
export class EchoCanceller {
  private readonly config: EchoCancellationConfig;
  private readonly sampleRate: number;
  private readonly filterLength: number;
  private readonly lagSamples: number;
  private readonly weights: Float64Array;
  private readonly reference: Float64Array;
  private writeIndex = 0;
  private filled = 0;
  private doubleTalk = false;
  private micPower = EPSILON;
  private refPower = EPSILON;
  private errorPower = EPSILON;
  private residualGain = 0;
  private readonly attackCoef: number;
  private readonly releaseCoef: number;
  private bypassed = false;
  private lastError: string | undefined;

  constructor(config: EchoCancellationConfig, sampleRate: number) {
    this.config = config;
    this.sampleRate = sampleRate;
    this.filterLength = Math.max(1, Math.round((config.filterLengthMs / 1000) * sampleRate));
    this.lagSamples = Math.max(0, Math.round((config.maxLagMs / 1000) * sampleRate));
    this.weights = new Float64Array(this.filterLength);
    this.reference = new Float64Array(this.filterLength + this.lagSamples + 1);
    const attackMs = 4;
    const releaseMs = 60;
    this.attackCoef = Math.exp(-1 / ((attackMs / 1000) * sampleRate));
    this.releaseCoef = Math.exp(-1 / ((releaseMs / 1000) * sampleRate));
  }

  get stats(): EchoCancellationStats {
    return {
      active: this.config.enabled && !this.bypassed,
      erleDb: toDb(this.errorPower) - toDb(this.micPower),
      doubleTalk: this.doubleTalk,
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    };
  }

  /** Feed the far-end reference — the PCM Aria is playing — one frame at a time. */
  setFarEnd(frame: Float64Array): void {
    if (!this.config.enabled || this.bypassed) return;
    for (let i = 0; i < frame.length; i += 1) {
      this.reference[this.writeIndex] = frame[i] as number;
      this.writeIndex = (this.writeIndex + 1) % this.reference.length;
      if (this.filled < this.reference.length) this.filled += 1;
    }
  }

  /**
   * Cancel echo from one microphone frame, returning a new array. On an internal
   * failure the frame is passed through unchanged and the failure is recorded.
   */
  process(mic: Float64Array): Float64Array {
    if (!this.config.enabled) return mic;
    if (this.bypassed) return mic;
    try {
      return this.processInternal(mic);
    } catch (error) {
      this.bypassed = true;
      this.lastError = error instanceof Error ? error.message : 'echo cancellation failed';
      return mic;
    }
  }

  reset(): void {
    this.weights.fill(0);
    this.reference.fill(0);
    this.writeIndex = 0;
    this.filled = 0;
    this.doubleTalk = false;
    this.micPower = EPSILON;
    this.refPower = EPSILON;
    this.errorPower = EPSILON;
    this.residualGain = 0;
  }

  private processInternal(mic: Float64Array): Float64Array {
    const out = new Float64Array(mic.length);
    const filterLength = this.filterLength;
    const mu = this.config.stepSize;
    const margin = 10 ** (this.config.doubleTalkMarginDb / 10);
    const suppression = 10 ** (this.config.suppressionDb / 10);

    for (let n = 0; n < mic.length; n += 1) {
      const referenceIndex = this.referenceIndexBefore(n) - filterLength + 1;
      const micSample = mic[n] as number;

      let estimate = 0;
      let energy = EPSILON;
      let peakReference = EPSILON;
      for (let k = 0; k < filterLength; k += 1) {
        const x = this.sampleAt(referenceIndex + k);
        estimate += (this.weights[k] as number) * x;
        energy += x * x;
        const magnitude = Math.abs(x);
        if (magnitude > peakReference) peakReference = magnitude;
      }

      const error = micSample - estimate;

      this.micPower = this.envelope(this.micPower, micSample * micSample);
      this.refPower = this.envelope(this.refPower, peakReference * peakReference);
      this.errorPower = this.envelope(this.errorPower, error * error);

      // Geigel: near-end is present when the mic exceeds the recent reference by
      // a margin. Freeze adaptation then, so a talker cannot bias the filter.
      this.doubleTalk = Math.abs(micSample) > margin * peakReference;

      if (!this.doubleTalk) {
        const scale = (mu * error) / energy;
        for (let k = 0; k < filterLength; k += 1) {
          const x = this.sampleAt(referenceIndex + k);
          this.weights[k] = (this.weights[k] as number) + scale * x;
        }
      }

      const referenceActive = this.refPower > this.micPower * 4 + EPSILON;
      const target = referenceActive && !this.doubleTalk ? suppression : 1;
      const coef = target < this.residualGain ? this.attackCoef : this.releaseCoef;
      this.residualGain = target + (this.residualGain - target) * coef;

      let sample = error * this.residualGain;
      if (sample > 1) sample = 1;
      else if (sample < -1) sample = -1;
      out[n] = sample;
    }
    return out;
  }

  private envelope(current: number, next: number): number {
    const coef = next > current ? this.attackCoef : this.releaseCoef;
    return next + (current - next) * coef;
  }

  private referenceIndexBefore(n: number): number {
    const advance = this.reference.length - this.lagSamples + n;
    return ((this.writeIndex - advance) % this.reference.length + this.reference.length) %
      this.reference.length;
  }

  private sampleAt(index: number): number {
    const length = this.reference.length;
    const wrapped = ((index % length) + length) % length;
    return this.reference[wrapped] as number;
  }
}

/**
 * A bounded far-end reference queue shared between the speaker tap and every
 * consumer that needs to cancel playback echo (the wake listener and each
 * session). Playback chunks are pushed in; a consumer drains exactly as many
 * samples as its capture frame, so mic and reference stay frame-aligned. A
 * consumer that outruns playback receives silence, which the canceller treats
 * as "no reference" rather than as echo to remove.
 */
export class FarEndReference {
  private readonly capacity: number;
  private queue: number[] = [];

  constructor(sampleRate: number, maxSeconds = 2) {
    this.capacity = Math.max(1, Math.round(sampleRate * maxSeconds));
  }

  push(chunk: Int16Array): void {
    for (let i = 0; i < chunk.length; i += 1) {
      this.queue.push((chunk[i] as number) / 32_768);
    }
    if (this.queue.length > this.capacity) {
      this.queue.splice(0, this.queue.length - this.capacity);
    }
  }

  /** Drain `count` samples, padding with silence when playback has run dry. */
  drain(count: number): Float64Array {
    const out = new Float64Array(count);
    const available = Math.min(count, this.queue.length);
    for (let i = 0; i < available; i += 1) out[i] = this.queue[i] as number;
    if (available > 0) this.queue.splice(0, available);
    return out;
  }

  clear(): void {
    this.queue = [];
  }

  get depth(): number {
    return this.queue.length;
  }
}

/** Build an echo canceller, validating the configuration. */
export function createEchoCanceller(
  config: EchoCancellationConfig,
  sampleRate: number,
): EchoCanceller {
  if (config.enabled) {
    if (!(config.filterLengthMs > 0)) {
      throw new VoiceError('invalid_configuration', 'Echo-cancellation filter length must be > 0 ms.');
    }
    if (!(config.stepSize > 0 && config.stepSize <= 1)) {
      throw new VoiceError('invalid_configuration', 'Echo-cancellation step size must be in (0, 1].');
    }
    if (!(config.suppressionDb <= 0)) {
      throw new VoiceError('invalid_configuration', 'Echo-cancellation suppression must be <= 0 dB.');
    }
    if (!(config.maxLagMs >= 0)) {
      throw new VoiceError('invalid_configuration', 'Echo-cancellation max lag must be >= 0 ms.');
    }
  }
  return new EchoCanceller(config, sampleRate);
}
