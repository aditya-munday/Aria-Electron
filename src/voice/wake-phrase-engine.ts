/**
 * The local wake-word engine.
 *
 * A self-contained, dependency-free keyword spotter: given a wake phrase it
 * detects that phrase in a stream of microphone frames, entirely offline. It
 * implements the runtime's {@link WakeWordEngine} seam, so it needs no model
 * file and no native dependency to load — which is what makes wake-word
 * detection actually function on a stock install instead of failing with a
 * "model not installed" blocker.
 *
 * How it works:
 *   1. Each frame is reduced to a small feature vector: loudness, zero-crossing
 *      rate, and the fraction of energy in low/mid/high bands. That shape is a
 *      crude but real spectral fingerprint of the sound.
 *   2. A template is built once from the phrase, mapping each grapheme to a
 *      phoneme-class prototype (vowels are low-band and steady, fricatives are
 *      high-band and noisy, and so on).
 *   3. Speech activity (frames above an adaptive noise floor) is grouped into
 *      segments; each segment is matched against the template with dynamic time
 *      warping, which tolerates different speaking rates. A close enough match,
 *      above a confidence floor, is a detection.
 *
 * It is deliberately conservative: a segment must look like speech of roughly
 * the right length before it is matched at all, so steady noise and a lone
 * cough do not fire it. A phrase-specific *trained* model (openWakeWord,
 * Porcupine, …) can replace this engine through `ARIA_WAKE_ENGINE` without any
 * change above the {@link WakeWordEngine} seam.
 */

import { VoiceError } from './errors.js';
import type { WakeWordDetection, WakeWordEngine } from './wake-word.js';

export interface WakePhraseEngineConfig {
  readonly engineId: string;
  readonly phrase: string;
  readonly sampleRate: number;
  /** Frame size in ms the engine expects; the runtime feeds matching frames. */
  readonly frameMs: number;
  /** Frames above the noise floor by this many dB count as speech activity. */
  readonly activityMarginDb: number;
  /** A silent gap this long (ms) closes the current segment. */
  readonly segmentGapMs: number;
  /** Normalized DTW distance below which a segment is a detection. */
  readonly matchThreshold: number;
}

export const DEFAULT_WAKE_PHRASE_ENGINE: Omit<WakePhraseEngineConfig, 'phrase' | 'sampleRate'> = {
  engineId: 'aria-phrase-spotter',
  frameMs: 20,
  activityMarginDb: 6,
  segmentGapMs: 300,
  matchThreshold: 0.5,
};

interface FrameFeatures {
  readonly logRms: number;
  readonly zcr: number;
  readonly bands: readonly [number, number, number];
}

interface Phoneme {
  readonly bands: readonly [number, number, number];
  readonly zcr: number;
  readonly frames: number;
}

const LOW = 0;
const MID = 1;
const HIGH = 2;

const VOWEL: Phoneme = { bands: [0.72, 0.22, 0.06], zcr: 0.06, frames: 2 };
const FRICATIVE: Phoneme = { bands: [0.06, 0.24, 0.7], zcr: 0.5, frames: 1 };
const PLOSIVE: Phoneme = { bands: [0.4, 0.35, 0.25], zcr: 0.2, frames: 1 };
const NASAL: Phoneme = { bands: [0.6, 0.3, 0.1], zcr: 0.12, frames: 1 };
const LIQUID: Phoneme = { bands: [0.55, 0.38, 0.07], zcr: 0.18, frames: 1 };
const SILENCE: Phoneme = { bands: [0.34, 0.33, 0.33], zcr: 0.04, frames: 1 };

const GRAPHEMES: Readonly<Record<string, Phoneme>> = {
  a: VOWEL, e: VOWEL, i: VOWEL, o: VOWEL, u: VOWEL, y: VOWEL,
  s: FRICATIVE, z: FRICATIVE, f: FRICATIVE, v: FRICATIVE, x: FRICATIVE,
  h: FRICATIVE, c: FRICATIVE, j: FRICATIVE,
  p: PLOSIVE, t: PLOSIVE, k: PLOSIVE, b: PLOSIVE, d: PLOSIVE, g: PLOSIVE,
  m: NASAL, n: NASAL, q: PLOSIVE, w: LIQUID, r: LIQUID, l: LIQUID,
};

const WEIGHTS: readonly number[] = [0.7, 1.4, 1.2, 1.0, 1.4];

function toDb(amplitude: number): number {
  return 20 * Math.log10(Math.max(amplitude, 1e-6));
}

export class WakePhraseEngine implements WakeWordEngine {
  readonly engineId: string;
  readonly modelId: string;
  private readonly config: WakePhraseEngineConfig;
  private readonly template: readonly number[][];
  private readonly gapFrames: number;
  private initialized = false;

  private readonly lowPrev = { input: 0, output: 0 };
  private readonly midPrev = { input: 0, output: 0 };
  private segment: FrameFeatures[] = [];
  private gap = 0;
  private noiseFloorDb = -50;

  constructor(config: WakePhraseEngineConfig) {
    this.config = config;
    this.engineId = config.engineId;
    this.modelId = `phrase:${config.phrase.toLowerCase().trim()}`;
    this.gapFrames = Math.max(1, Math.round(config.segmentGapMs / config.frameMs));
    this.template = buildTemplate(config.phrase);
  }

  async init(): Promise<void> {
    if (this.template.length === 0) {
      throw new VoiceError('invalid_configuration', 'The wake phrase has no matchable content.');
    }
    // A reset re-inits the streaming state, so a stale segment or adapted noise
    // floor cannot leak into the next listen.
    this.reset();
    this.initialized = true;
  }

  process(frame: Float64Array): WakeWordDetection | undefined {
    if (!this.initialized) return undefined;
    const features = this.featurize(frame);
    const isActivity = features.logRms > this.noiseFloorDb + this.config.activityMarginDb;

    if (isActivity) {
      this.segment.push(features);
      this.gap = 0;
      return undefined;
    }

    // Adapt the noise floor only on quiet frames, so speech never raises it.
    this.noiseFloorDb = Math.max(-80, this.noiseFloorDb + (features.logRms - this.noiseFloorDb) * 0.02);
    if (this.segment.length === 0) return undefined;
    this.gap += 1;
    if (this.gap < this.gapFrames) return undefined;

    const segment = this.segment;
    this.segment = [];
    this.gap = 0;
    return this.match(segment);
  }

  reset(): void {
    this.segment = [];
    this.gap = 0;
    this.noiseFloorDb = -50;
    this.lowPrev.input = 0;
    this.lowPrev.output = 0;
    this.midPrev.input = 0;
    this.midPrev.output = 0;
  }

  async release(): Promise<void> {
    this.initialized = false;
  }

  private match(segment: FrameFeatures[]): WakeWordDetection | undefined {
    const minFrames = Math.max(1, Math.floor(this.template.length * 0.5));
    const maxFrames = Math.ceil(this.template.length * 2.2);
    if (segment.length < minFrames || segment.length > maxFrames) return undefined;

    const vectors = segment.map((f) => flatten(f));
    const distance = dtw(vectors, this.template) / this.template.length;
    if (distance > this.config.matchThreshold) return undefined;
    const confidence = Math.max(0, Math.min(1, 1 - distance));
    return { phrase: this.config.phrase.toLowerCase().trim(), confidence };
  }

  private featurize(frame: Float64Array): FrameFeatures {
    let sumSquares = 0;
    let crossings = 0;
    let lowEnergy = 0;
    let midEnergy = 0;
    let prev = 0;
    const lowAlpha = alphaFor(800, this.config.sampleRate);
    const midAlpha = alphaFor(2500, this.config.sampleRate);
    for (let i = 0; i < frame.length; i += 1) {
      const sample = frame[i] as number;
      sumSquares += sample * sample;
      if ((sample >= 0 && prev < 0) || (sample < 0 && prev >= 0)) crossings += 1;
      prev = sample;

      this.lowPrev.output = lowAlpha * (this.lowPrev.output + sample - this.lowPrev.input);
      this.lowPrev.input = sample;
      this.midPrev.output = midAlpha * (this.midPrev.output + sample - this.midPrev.input);
      this.midPrev.input = sample;

      const low = this.lowPrev.output;
      const mid = this.midPrev.output;
      lowEnergy += low * low;
      const midOnly = mid - low;
      midEnergy += midOnly * midOnly;
    }
    const total = sumSquares + 1e-9;
    const lowFraction = lowEnergy / total;
    const midFraction = midEnergy / total;
    const highFraction = Math.max(0, 1 - lowFraction - midFraction);
    const bandSum = lowFraction + midFraction + highFraction + 1e-9;
    const rms = Math.sqrt(sumSquares / Math.max(1, frame.length));
    return {
      logRms: toDb(rms),
      zcr: crossings / Math.max(1, frame.length),
      bands: [lowFraction / bandSum, midFraction / bandSum, highFraction / bandSum],
    };
  }
}

function alphaFor(cutoffHz: number, sampleRate: number): number {
  const rc = 1 / (2 * Math.PI * Math.max(1, cutoffHz));
  const dt = 1 / sampleRate;
  return rc / (rc + dt);
}

function flatten(f: FrameFeatures): number[] {
  return [f.logRms / 60, f.zcr, f.bands[LOW], f.bands[MID], f.bands[HIGH]];
}

/** Build a feature-vector template from the phrase's graphemes. */
function buildTemplate(phrase: string): number[][] {
  const frames: number[][] = [];
  const normalized = phrase.toLowerCase().trim();
  for (const ch of normalized) {
    if (ch === ' ') {
      pushPhoneme(frames, SILENCE);
      continue;
    }
    const phoneme = GRAPHEMES[ch];
    if (phoneme === undefined) continue;
    pushPhoneme(frames, phoneme);
  }
  return frames;
}

function pushPhoneme(frames: number[][], phoneme: Phoneme): void {
  for (let i = 0; i < phoneme.frames; i += 1) {
    frames.push([-0.5, phoneme.zcr, phoneme.bands[LOW], phoneme.bands[MID], phoneme.bands[HIGH]]);
  }
}

/** Weighted dynamic time warping distance between two feature-vector sequences. */
function dtw(a: readonly number[][], b: readonly number[][]): number {
  const n = a.length;
  const m = b.length;
  let previous = new Float64Array(m + 1).fill(Infinity);
  let current = new Float64Array(m + 1);
  previous[0] = 0;
  for (let i = 1; i <= n; i += 1) {
    current[0] = Infinity;
    for (let j = 1; j <= m; j += 1) {
      const cost = weightedDistance(a[i - 1] as number[], b[j - 1] as number[]);
      current[j] = cost + Math.min(previous[j] as number, current[j - 1] as number, previous[j - 1] as number);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[m] as number;
}

function weightedDistance(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < WEIGHTS.length; i += 1) {
    const weight = WEIGHTS[i] as number;
    const diff = (a[i] as number) - (b[i] as number);
    sum += weight * diff * diff;
  }
  return Math.sqrt(sum);
}

export function createWakePhraseEngine(
  phrase: string,
  sampleRate: number,
  overrides: Partial<WakePhraseEngineConfig> = {},
): WakeWordEngine {
  return new WakePhraseEngine({
    ...DEFAULT_WAKE_PHRASE_ENGINE,
    phrase,
    sampleRate,
    ...overrides,
  });
}
