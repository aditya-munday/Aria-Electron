/**
 * Voice activity detection.
 *
 * The VAD classifies each frame as speech or silence and tracks the speech
 * onset, the ongoing speech, and the end of the utterance. It is deliberately
 * separate from wake-word detection: the wake word decides *when the assistant
 * activates*, the VAD decides *when speech starts and ends*.
 *
 * It is energy-based with an adaptive noise floor and an attack/release
 * hysteresis, so a normal pause to think does not end the utterance: the
 * end-of-speech is only reported after `endSilenceMs` of continuous silence.
 * The thresholds are configurable and validated; the defaults suit 16 kHz
 * close-talk speech.
 *
 * A frame is `speech` when its energy is clearly above the tracked floor,
 * `silence` when clearly below, and `uncertain` in the hysteresis band (treated
 * as a continuation of the current state so it never flaps).
 */

import { VoiceError } from './errors.js';

export type VadFrame = 'silence' | 'speech' | 'uncertain';

export type VadEvent = 'speech_start' | 'speech_end' | 'none';

export interface VadConfig {
  readonly enabled: boolean;
  /** Frame size in ms; the caller pushes frames of this length. */
  readonly frameMs: number;
  /** Energy above the floor (dB) that opens the speech gate. */
  readonly speechStartDb: number;
  /** Energy above the floor (dB) below which speech is considered stopped. */
  readonly speechEndDb: number;
  /** Continuous silence (ms) before `speech_end` is reported. */
  readonly endSilenceMs: number;
  /** Continuous speech (ms) before `speech_start` is reported. */
  readonly onsetMs: number;
  /** The absolute floor used before any frame has been observed, in dBFS. */
  readonly initialFloorDb: number;
  /** How fast the floor tracks, per frame, in [0, 1]. */
  readonly floorAdaptRate: number;
}

export const DEFAULT_VAD: VadConfig = {
  enabled: true,
  frameMs: 20,
  speechStartDb: 6,
  speechEndDb: 3,
  endSilenceMs: 700,
  onsetMs: 60,
  initialFloorDb: -60,
  floorAdaptRate: 0.02,
};

export interface VadState {
  readonly inSpeech: boolean;
  readonly floorDb: number;
  readonly lastFrame: VadFrame;
  /** Milliseconds of the current continuous silence (when not in speech). */
  readonly silenceMs: number;
}

const EPSILON = 1e-9;

function rmsDb(frame: Float64Array): number {
  if (frame.length === 0) return -180;
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const s = frame[i] as number;
    sum += s * s;
  }
  const rms = Math.sqrt(sum / frame.length);
  return 20 * Math.log10(Math.max(rms, EPSILON));
}

export class VoiceActivityDetector {
  private readonly config: VadConfig;
  private floorDb: number;
  private inSpeech = false;
  private lastFrame: VadFrame = 'silence';
  private speechMs = 0;
  private silenceMs = 0;

  constructor(config: VadConfig) {
    this.config = config;
    this.floorDb = config.initialFloorDb;
  }

  get state(): VadState {
    return {
      inSpeech: this.inSpeech,
      floorDb: this.floorDb,
      lastFrame: this.lastFrame,
      silenceMs: this.silenceMs,
    };
  }

  /**
   * Push one frame; returns the transition this frame caused, if any. A frame
   * that merely continues the current state returns `none`.
   */
  push(frame: Float64Array): VadEvent {
    if (!this.config.enabled) {
      // A disabled VAD still reports the utterance as one continuous speech
      // span, so push-to-talk (which supplies its own boundaries) is unaffected.
      const wasSpeech = this.inSpeech;
      this.inSpeech = true;
      this.lastFrame = 'speech';
      return wasSpeech ? 'none' : 'speech_start';
    }

    const db = rmsDb(frame);
    const startThreshold = this.floorDb + this.config.speechStartDb;
    const endThreshold = this.floorDb + this.config.speechEndDb;

    let frameClass: VadFrame;
    if (db >= startThreshold) frameClass = 'speech';
    else if (db < endThreshold) frameClass = 'silence';
    else frameClass = 'uncertain';

    // Track the floor only while clearly in silence, and only downward-biased,
    // so a long utterance never raises the floor above its own speech.
    if (frameClass === 'silence' && db < this.floorDb + this.config.speechStartDb) {
      this.floorDb += (db - this.floorDb) * this.config.floorAdaptRate;
      if (this.floorDb < -90) this.floorDb = -90;
    }

    let event: VadEvent = 'none';
    if (frameClass === 'speech') {
      this.silenceMs = 0;
      this.speechMs += this.config.frameMs;
      if (!this.inSpeech && this.speechMs >= this.config.onsetMs) {
        this.inSpeech = true;
        event = 'speech_start';
      }
    } else if (frameClass === 'silence') {
      this.speechMs = 0;
      if (this.inSpeech) {
        this.silenceMs += this.config.frameMs;
        if (this.silenceMs >= this.config.endSilenceMs) {
          this.inSpeech = false;
          event = 'speech_end';
        }
      }
    } else {
      // Uncertain: hold the current state, but reset the opposite timer.
      if (this.inSpeech) this.silenceMs = 0;
      else this.speechMs = 0;
    }

    this.lastFrame = frameClass;
    return event;
  }

  /** Force the utterance closed (push-to-talk release, max duration, teardown). */
  forceEnd(): VadEvent {
    if (!this.inSpeech) return 'none';
    this.inSpeech = false;
    this.silenceMs = 0;
    return 'speech_end';
  }

  reset(): void {
    this.floorDb = this.config.initialFloorDb;
    this.inSpeech = false;
    this.lastFrame = 'silence';
    this.speechMs = 0;
    this.silenceMs = 0;
  }
}

export function createVad(config: VadConfig): VoiceActivityDetector {
  if (config.enabled) {
    if (!(config.frameMs > 0)) {
      throw new VoiceError('invalid_configuration', 'VAD frame size must be > 0 ms.');
    }
    if (!(config.speechStartDb > config.speechEndDb)) {
      throw new VoiceError(
        'invalid_configuration',
        'VAD start threshold must exceed the end threshold.',
      );
    }
    if (!(config.endSilenceMs > 0)) {
      throw new VoiceError('invalid_configuration', 'VAD end-silence must be > 0 ms.');
    }
    if (!(config.floorAdaptRate > 0 && config.floorAdaptRate <= 1)) {
      throw new VoiceError('invalid_configuration', 'VAD floor adapt rate must be in (0, 1].');
    }
  }
  return new VoiceActivityDetector(config);
}
