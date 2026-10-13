/**
 * The local wake-word engine.
 *
 * A self-contained, dependency-free keyword spotter that detects a wake phrase
 * in microphone frames entirely offline. It implements the runtime's
 * {@link WakeWordEngine} seam, so it needs no model file and no native
 * dependency to load.
 *
 * Each frame is reduced to the features that carry speech identity: a formant
 * estimate (F1/F2, which distinguishes one vowel from another), a tonal↔noisy
 * measure and the low/mid/high band split. The phrase is rendered through the
 * same synthesiser and featurizer the audio path uses, at several speaking
 * rates, so template and audio share one feature space. A segment must look
 * like speech of roughly the right length, be voiced-dominant and show spectral
 * movement, then match a rate template by spectral DTW — so a hum, a fan and an
 * unrelated phrase all fail while the phrase itself passes.
 *
 * A trained model (openWakeWord, Porcupine, …) can replace this engine through
 * `ARIA_WAKE_ENGINE` without any change above the {@link WakeWordEngine} seam.
 */

import { VoiceError } from './errors.js';
import { synthesizePhrase, resample } from './formant-synth.js';
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
  /** Minimum fraction of tonal frames a segment must contain to be matched. */
  readonly minVoicedFraction?: number;
  /** Minimum per-segment spectral movement (band/centroid std) to be matched. */
  readonly minVariation?: number;
}

export const DEFAULT_WAKE_PHRASE_ENGINE: Omit<WakePhraseEngineConfig, 'phrase' | 'sampleRate'> = {
  engineId: 'aria-phrase-spotter',
  frameMs: 20,
  activityMarginDb: 6,
  segmentGapMs: 300,
  matchThreshold: 0.45,
  minVoicedFraction: 0.3,
  minVariation: 0.02,
};

/** A best-effort offline report for the Diagnostics "test wake word" surface. */
export interface WakePhraseScore {
  readonly matched: boolean;
  readonly confidence: number;
  readonly distance: number;
  readonly segments: number;
  readonly bestFrames: number;
}

interface FrameFeatures {
  readonly logRms: number;
  readonly zcr: number;
  readonly flatness: number;
  readonly centroid: number;
  readonly f1: number;
  readonly f2: number;
  readonly bands: readonly [number, number, number];
  /** Normalized Goertzel spectrum, the richest view of the frame's shape. */
  readonly spectrum: readonly number[];
}

const LOW = 0;
const MID = 1;
const HIGH = 2;

const WEIGHTS: readonly number[] = [1.0, 1.2, 1.2, 1.2, 1.0, 1.6, 1.6];

/** The speaking-rate multipliers the phrase is matched against as an ensemble. */
const TEMPLATE_RATES: readonly number[] = [0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.4];

/** Log-spaced analysis frequencies for the spectral shape estimate, in Hz. */
const SPECTRUM_BINS: readonly number[] = [90, 150, 250, 400, 650, 1000, 1600, 2500, 4000, 6000];

function toDb(amplitude: number): number {
  return 20 * Math.log10(Math.max(amplitude, 1e-6));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function alphaFor(cutoffHz: number, sampleRate: number): number {
  const rc = 1 / (2 * Math.PI * Math.max(1, cutoffHz));
  const dt = 1 / sampleRate;
  return rc / (rc + dt);
}

export class WakePhraseEngine implements WakeWordEngine {
  readonly engineId: string;
  readonly modelId: string;
  private readonly config: WakePhraseEngineConfig;
  private readonly templates: readonly number[][][];
  private readonly minFrames: number;
  private readonly maxFrames: number;
  private readonly minVoicedFraction: number;
  private readonly minVariation: number;
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
    this.minVoicedFraction = config.minVoicedFraction ?? 0.3;
    this.minVariation = config.minVariation ?? 0.02;
    this.gapFrames = Math.max(1, Math.round(config.segmentGapMs / config.frameMs));
    this.templates = TEMPLATE_RATES.map((rate) => this.buildTemplate(config.phrase, rate));
    const lengths = this.templates.map((t) => t.length).filter((n) => n > 0);
    this.minFrames = Math.max(1, Math.floor(Math.min(...lengths) * 0.45));
    this.maxFrames = Math.ceil(Math.max(...lengths) * 2.2);
  }

  async init(): Promise<void> {
    if (this.templates.every((template) => template.length === 0)) {
      throw new VoiceError('invalid_configuration', 'The wake phrase has no matchable content.');
    }
    this.reset();
    this.initialized = true;
  }

  process(frame: Float64Array): WakeWordDetection | undefined {
    if (!this.initialized) return undefined;
    const features = this.featurize(frame);
    if (features.logRms > this.noiseFloorDb + this.config.activityMarginDb) {
      this.segment.push(features);
      this.gap = 0;
      return undefined;
    }
    this.noiseFloorDb = Math.max(-80, this.noiseFloorDb + (features.logRms - this.noiseFloorDb) * 0.02);
    if (this.segment.length === 0) return undefined;
    this.gap += 1;
    if (this.gap < this.gapFrames) return undefined;

    const segment = this.segment;
    this.segment = [];
    this.gap = 0;
    const match = this.matchSegment(segment);
    if (!match.matched) return undefined;
    return { phrase: this.config.phrase.toLowerCase().trim(), confidence: match.confidence };
  }

  /**
   * Score a complete buffer offline, without a live stream. It is the same
   * pipeline the streaming path runs, exposed so Diagnostics can answer "did
   * the phrase I just said match?" honestly instead of guessing.
   */
  score(frames: readonly Float64Array[]): WakePhraseScore {
    this.reset();
    const wasInitialized = this.initialized;
    this.initialized = true;
    let segments = 0;
    let best = { matched: false, confidence: 0, distance: 1 };
    let bestFrames = 0;
    for (const frame of frames) {
      const features = this.featurize(frame);
      if (features.logRms > this.noiseFloorDb + this.config.activityMarginDb) {
        this.segment.push(features);
        this.gap = 0;
        continue;
      }
      this.noiseFloorDb = Math.max(-80, this.noiseFloorDb + (features.logRms - this.noiseFloorDb) * 0.02);
      if (this.segment.length === 0) continue;
      this.gap += 1;
      if (this.gap < this.gapFrames) continue;
      const segment = this.segment;
      this.segment = [];
      this.gap = 0;
      segments += 1;
      const match = this.matchSegment(segment);
      if (match.distance < best.distance) {
        best = match;
        bestFrames = segment.length;
      }
    }
    this.initialized = wasInitialized;
    return { ...best, segments, bestFrames };
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

  /**
   * A template for one speaking rate, produced by rendering the phrase through
   * the same synthesiser and featurizer the audio path uses. Building the
   * template this way keeps it in the exact feature space of real frames.
   */
  private buildTemplate(phrase: string, rate: number): number[][] {
    const samples = resample(synthesizePhrase(phrase, this.config.sampleRate), rate);
    const frameSamples = Math.max(1, Math.round((this.config.frameMs / 1000) * this.config.sampleRate));
    const frames: number[][] = [];
    for (let start = 0; start < samples.length; start += frameSamples) {
      const frame = new Float64Array(frameSamples);
      frame.set(samples.subarray(start, Math.min(start + frameSamples, samples.length)));
      frames.push(flatten(this.featurize(frame)));
    }
    return frames;
  }

  private matchSegment(
    segment: FrameFeatures[],
  ): { matched: boolean; confidence: number; distance: number } {
    if (segment.length < this.minFrames || segment.length > this.maxFrames) {
      return { matched: false, confidence: 0, distance: 1 };
    }
    if (voicedFraction(segment) < this.minVoicedFraction) {
      return { matched: false, confidence: 0, distance: 1 };
    }
    if (spectralVariation(segment) < this.minVariation) {
      return { matched: false, confidence: 0, distance: 1 };
    }

    const vectors = segment.map((f) => flatten(f));
    let distance = Infinity;
    for (const template of this.templates) {
      if (template.length === 0) continue;
      const candidate = dtw(vectors, template) / template.length;
      if (candidate < distance) distance = candidate;
    }
    const matched = distance <= this.config.matchThreshold;
    return { matched, confidence: clamp01(1 - Math.min(1, distance)), distance };
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
    const spectral = spectrumShape(frame, this.config.sampleRate);
    const formants = estimateFormants(spectral.spectrum);
    return {
      logRms: toDb(rms),
      zcr: crossings / Math.max(1, frame.length),
      flatness: spectral.flatness,
      centroid: spectral.centroid,
      f1: formants.f1,
      f2: formants.f2,
      bands: [lowFraction / bandSum, midFraction / bandSum, highFraction / bandSum],
      spectrum: spectral.spectrum,
    };
  }
}

interface SpectralShape {
  readonly flatness: number;
  readonly centroid: number;
  /** Goertzel magnitudes over {@link SPECTRUM_BINS}, normalized to sum 1. */
  readonly spectrum: readonly number[];
}

/** Flatness (tonal↔noisy), normalized centroid and the spectrum, from Goertzel bins. */
function spectrumShape(frame: Float64Array, sampleRate: number): SpectralShape {
  const magnitudes: number[] = [];
  let sum = 0;
  let logSum = 0;
  let weighted = 0;
  const nyquist = sampleRate / 2;
  for (const freq of SPECTRUM_BINS) {
    const magnitude = goertzel(frame, sampleRate, freq);
    magnitudes.push(magnitude);
    sum += magnitude;
    logSum += Math.log(magnitude + 1e-9);
    weighted += (freq / nyquist) * magnitude;
  }
  const n = magnitudes.length;
  const arithmetic = sum / n + 1e-9;
  const geometric = Math.exp(logSum / n);
  const normalized = magnitudes.map((m) => m / (sum + 1e-9));
  return {
    flatness: clamp01(geometric / arithmetic),
    centroid: clamp01(sum > 1e-9 ? weighted / sum : 0),
    spectrum: normalized,
  };
}

function goertzel(frame: Float64Array, sampleRate: number, freq: number): number {
  const w = (2 * Math.PI * freq) / sampleRate;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const s0 = (frame[i] as number) + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - c * s1 * s2;
  return Math.sqrt(Math.max(0, power)) / Math.max(1, frame.length);
}

/**
 * A crude formant estimate: F1 is the strongest bin below the fricative
 * threshold, F2 the strongest bin above it. Each is normalized by the Nyquist
 * frequency. Coarse, but it is what lets two different vowels differ.
 */
function estimateFormants(spectrum: readonly number[]): { f1: number; f2: number } {
  const nyquist = 8000;
  const cutoff = SPECTRUM_BINS.findIndex((freq) => freq / nyquist >= 0.4);
  const split = cutoff < 0 ? spectrum.length : cutoff;
  let f1Bin = 0;
  let f1Value = -1;
  for (let i = 0; i < split; i += 1) {
    const value = spectrum[i] as number;
    if (value > f1Value) {
      f1Value = value;
      f1Bin = i;
    }
  }
  let f2Bin = split;
  let f2Value = -1;
  for (let i = split; i < spectrum.length; i += 1) {
    const value = spectrum[i] as number;
    if (value > f2Value) {
      f2Value = value;
      f2Bin = i;
    }
  }
  return {
    f1: clamp01((SPECTRUM_BINS[f1Bin] as number) / nyquist),
    f2: clamp01((SPECTRUM_BINS[f2Bin] as number) / nyquist),
  };
}

/** The fraction of a segment's frames that are tonal (vowel-like). */
function voicedFraction(segment: readonly FrameFeatures[]): number {
  if (segment.length === 0) return 0;
  let voiced = 0;
  for (const frame of segment) if (frame.flatness < 0.5) voiced += 1;
  return voiced / segment.length;
}

/** How much the segment's spectral shape moves — speech moves, a hum does not. */
function spectralVariation(segment: readonly FrameFeatures[]): number {
  if (segment.length < 2) return 0;
  let centroidSum = 0;
  let f1Sum = 0;
  for (const frame of segment) {
    centroidSum += frame.centroid;
    f1Sum += frame.f1;
  }
  const centroidMean = centroidSum / segment.length;
  const f1Mean = f1Sum / segment.length;
  let centroidVar = 0;
  let f1Var = 0;
  for (const frame of segment) {
    const dc = frame.centroid - centroidMean;
    const df = frame.f1 - f1Mean;
    centroidVar += dc * dc;
    f1Var += df * df;
  }
  return Math.sqrt(Math.max(centroidVar, f1Var) / segment.length);
}

function flatten(f: FrameFeatures): number[] {
  return [f.zcr, f.bands[LOW], f.bands[MID], f.bands[HIGH], f.flatness, f.f1, f.f2, ...f.spectrum];
}

/**
 * Per-dimension weights: the summary scalars first, then one per spectrum bin.
 * The spectrum carries the fine shape that separates two different vowels.
 */
const FEATURE_WEIGHTS: readonly number[] = [
  ...WEIGHTS,
  ...SPECTRUM_BINS.map(() => 1.2),
];

/** Weighted dynamic time warping distance, constrained to a Sakoe-Chiba band. */
function dtw(a: readonly number[][], b: readonly number[][]): number {
  const n = a.length;
  const m = b.length;
  const band = Math.max(1, Math.ceil(0.15 * Math.max(n, m)));
  let previous = new Float64Array(m + 1).fill(Infinity);
  let current = new Float64Array(m + 1);
  previous[0] = 0;
  for (let i = 1; i <= n; i += 1) {
    current.fill(Infinity);
    const lo = Math.max(1, i - band);
    const hi = Math.min(m, i + band);
    for (let j = lo; j <= hi; j += 1) {
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
  for (let i = 0; i < FEATURE_WEIGHTS.length; i += 1) {
    const weight = FEATURE_WEIGHTS[i] as number;
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
