/**
 * Local noise reduction.
 *
 * A small, honest time-domain denoiser: a DC/rumble high-pass followed by an
 * adaptive downward expander (a soft noise gate). It estimates the noise floor
 * from quiet frames and attenuates samples that sit near that floor, while
 * leaving speech above it essentially untouched. It is deliberately not a full
 * spectral denoiser, and it never mutes outright: the maximum attenuation is a
 * bounded gain so a quiet word is reduced, not lost.
 *
 * It runs before speech is submitted for recognition and never touches the
 * network. A failure to construct or process is observable and follows a
 * defined fallback (bypass), so a denoiser problem cannot stall a session.
 */

import { VoiceError } from './errors.js';

export interface NoiseReductionConfig {
  readonly enabled: boolean;
  /** High-pass cutoff in Hz; removes DC offset and low rumble. */
  readonly highPassHz: number;
  /** How far above the floor (dB) a sample must be to pass at unity gain. */
  readonly gateOpenDb: number;
  /** The most the gate attenuates when fully closed, in dB (a negative number). */
  readonly maxAttenuationDb: number;
  /** Gain ramp-up when the gate opens, in ms. */
  readonly attackMs: number;
  /** Gain ramp-down when the gate closes, in ms. */
  readonly releaseMs: number;
  /** How fast the noise floor tracks, per frame, in [0, 1]. */
  readonly floorAdaptRate: number;
}

export const DEFAULT_NOISE_REDUCTION: NoiseReductionConfig = {
  enabled: true,
  highPassHz: 80,
  gateOpenDb: 6,
  maxAttenuationDb: -18,
  attackMs: 5,
  releaseMs: 120,
  floorAdaptRate: 0.05,
};

export interface NoiseReductionStats {
  /** Whether processing is currently applied or bypassed. */
  readonly active: boolean;
  /** The tracked noise floor, in dBFS. */
  readonly floorDb: number;
  /** The number of samples clamped because the filter overshot [-1, 1]. */
  readonly clipped: number;
  /** The last error that caused a bypass, if any. */
  readonly lastError?: string;
}

const EPSILON = 1e-9;

function toDb(amplitude: number): number {
  return 10 * Math.log10(Math.max(amplitude, EPSILON));
}

/**
 * A stateful denoiser. One instance is bound to one audio stream; it carries the
 * filter and envelope state between frames.
 */
export class NoiseReducer {
  private readonly config: NoiseReductionConfig;
  private readonly sampleRate: number;
  private hpPrevInput = 0;
  private hpPrevOutput = 0;
  private readonly hpAlpha: number;
  private envelope = 0;
  private floorLinear = EPSILON;
  private gain = 1;
  private readonly attackCoef: number;
  private readonly releaseCoef: number;
  private clipped = 0;
  private bypassed = false;
  private lastError: string | undefined;

  constructor(config: NoiseReductionConfig, sampleRate: number) {
    this.config = config;
    this.sampleRate = sampleRate;
    // First-order high-pass coefficient.
    const rc = 1 / (2 * Math.PI * Math.max(1, config.highPassHz));
    const dt = 1 / sampleRate;
    this.hpAlpha = rc / (rc + dt);
    this.attackCoef = Math.exp(-1 / ((config.attackMs / 1000) * sampleRate));
    this.releaseCoef = Math.exp(-1 / ((config.releaseMs / 1000) * sampleRate));
  }

  get stats(): NoiseReductionStats {
    return {
      active: this.config.enabled && !this.bypassed,
      floorDb: toDb(this.floorLinear),
      clipped: this.clipped,
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    };
  }

  /**
   * Process one frame in place-safe fashion, returning a new array. On an
   * internal failure the frame is passed through unchanged and the failure is
   * recorded (observable), never thrown into the audio callback.
   */
  process(frame: Float64Array): Float64Array {
    if (!this.config.enabled) return frame;
    if (this.bypassed) return frame;
    try {
      return this.processInternal(frame);
    } catch (error) {
      // A denoiser failure must not stall a session: bypass and report.
      this.bypassed = true;
      this.lastError = error instanceof Error ? error.message : 'noise reduction failed';
      return frame;
    }
  }

  private processInternal(frame: Float64Array): Float64Array {
    const out = new Float64Array(frame.length);
    const openRatio = 10 ** (this.config.gateOpenDb / 10);
    const maxAtten = 10 ** (this.config.maxAttenuationDb / 10);

    for (let i = 0; i < frame.length; i += 1) {
      const raw = frame[i] as number;
      // First-order high-pass.
      const hp = this.hpAlpha * (this.hpPrevOutput + raw - this.hpPrevInput);
      this.hpPrevInput = raw;
      this.hpPrevOutput = hp;

      // Peak envelope follower.
      const magnitude = Math.abs(hp);
      this.envelope = Math.max(magnitude, this.envelope * this.releaseCoef);

      // The floor tracks the quietest recent envelope.
      if (this.envelope < this.floorLinear) {
        this.floorLinear += (this.envelope - this.floorLinear) * this.config.floorAdaptRate;
      } else {
        // Adapt upward very slowly so a long utterance does not raise the floor.
        this.floorLinear += (this.envelope - this.floorLinear) * this.config.floorAdaptRate * 0.05;
      }

      // Target gain: unity when clearly above the floor, attenuated near it.
      const target = this.envelope > this.floorLinear * openRatio ? 1 : maxAtten;
      const coef = target > this.gain ? this.attackCoef : this.releaseCoef;
      this.gain = target + (this.gain - target) * coef;

      let sample = hp * this.gain;
      if (sample > 1) {
        sample = 1;
        this.clipped += 1;
      } else if (sample < -1) {
        sample = -1;
        this.clipped += 1;
      }
      out[i] = sample;
    }
    return out;
  }

  reset(): void {
    this.hpPrevInput = 0;
    this.hpPrevOutput = 0;
    this.envelope = 0;
    this.floorLinear = EPSILON;
    this.gain = 1;
  }
}

/** Build a denoiser, validating the configuration. */
export function createNoiseReducer(
  config: NoiseReductionConfig,
  sampleRate: number,
): NoiseReducer {
  if (config.enabled) {
    if (!(config.highPassHz > 0)) {
      throw new VoiceError('invalid_configuration', 'Noise-reduction high-pass must be > 0 Hz.');
    }
    if (!(config.maxAttenuationDb <= 0)) {
      throw new VoiceError(
        'invalid_configuration',
        'Noise-reduction max attenuation must be <= 0 dB.',
      );
    }
    if (!(config.floorAdaptRate > 0 && config.floorAdaptRate <= 1)) {
      throw new VoiceError(
        'invalid_configuration',
        'Noise-reduction floor adapt rate must be in (0, 1].',
      );
    }
  }
  return new NoiseReducer(config, sampleRate);
}
