import { describe, expect, it } from 'vitest';

import { createWakePhraseEngine, WakePhraseEngine } from './wake-phrase-engine.js';
import type { WakeWordDetection, WakeWordEngine } from './wake-word.js';
import { silence, tone } from './testing/fake-audio.js';

const SAMPLE_RATE = 16_000;
const FRAME_MS = 20;

/** A crude "spoken" phrase: a run of voiced formant-like tones then silence. */
function utterance(samples: number, seed = 1): Float64Array {
  const out = new Float64Array(samples);
  const formants = [180, 700, 1100, 240, 900, 1300];
  for (let i = 0; i < samples; i += 1) {
    const segment = Math.floor((i / samples) * formants.length);
    const hz = formants[Math.min(segment, formants.length - 1)] as number;
    out[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) * (0.8 + 0.2 * Math.sin(seed + i));
  }
  return out;
}

function feed(engine: WakeWordEngine, frames: Float64Array[]): WakeWordDetection | undefined {
  let detection: WakeWordDetection | undefined;
  for (const frame of frames) {
    const result = engine.process(frame);
    if (result !== undefined) detection = result;
  }
  return detection;
}

function framesOf(totalSamples: number, generator: (i: number) => Float64Array): Float64Array[] {
  const count = Math.ceil(totalSamples / 320);
  return Array.from({ length: count }, (_, i) => generator(i));
}

describe('WakePhraseEngine', () => {
  it('reports a phrase-model id and initializes without a model file', async () => {
    const engine = createWakePhraseEngine('hey aria', SAMPLE_RATE);
    expect(engine.engineId).toBe('aria-phrase-spotter');
    expect(engine.modelId).toBe('phrase:hey aria');
    await expect(engine.init()).resolves.toBeUndefined();
  });

  it('ignores frames before init', () => {
    const engine = new WakePhraseEngine({
      phrase: 'hey aria',
      sampleRate: SAMPLE_RATE,
      frameMs: FRAME_MS,
      engineId: 'e',
      activityMarginDb: 6,
      segmentGapMs: 300,
      matchThreshold: 0.5,
    });
    expect(engine.process(tone(320, 0.8))).toBeUndefined();
  });

  it('does not fire on steady noise', async () => {
    const engine = createWakePhraseEngine('hey aria', SAMPLE_RATE);
    await engine.init();
    const detection = feed(engine, framesOf(32_000, () => tone(320, 0.4, 440, SAMPLE_RATE)));
    expect(detection).toBeUndefined();
  });

  it('does not fire on a single short blip', async () => {
    const engine = createWakePhraseEngine('hey aria', SAMPLE_RATE);
    await engine.init();
    const detection = feed(engine, [
      ...framesOf(1_920, () => silence(320)),
      tone(320, 0.7),
      ...framesOf(6_400, () => silence(320)),
    ]);
    expect(detection).toBeUndefined();
  });

  it('reports a confidence in (0, 1] when a phrase-shaped utterance matches', async () => {
    // The synthetic formant run stands in for speech; a slightly looser
    // threshold than the default isolates the "fires and reports confidence"
    // behavior from the accuracy of the synthetic signal.
    const engine = new WakePhraseEngine({
      phrase: 'hey aria',
      sampleRate: SAMPLE_RATE,
      frameMs: FRAME_MS,
      engineId: 'aria-phrase-spotter',
      activityMarginDb: 6,
      segmentGapMs: 300,
      matchThreshold: 0.6,
    });
    await engine.init();
    const voiced = utterance(2_400);
    const frames = [
      ...Array.from({ length: Math.ceil(voiced.length / 320) }, (_, i) =>
        voiced.slice(i * 320, (i + 1) * 320),
      ),
      ...framesOf(6_400, () => silence(320)),
    ];
    const detection = feed(engine, frames);
    expect(detection).toBeDefined();
    expect(detection?.phrase).toBe('hey aria');
    expect(detection?.confidence).toBeGreaterThan(0);
    expect(detection?.confidence).toBeLessThanOrEqual(1);
  });

  it('resets cleanly', async () => {
    const engine = createWakePhraseEngine('hey aria', SAMPLE_RATE);
    await engine.init();
    engine.reset();
    await engine.release();
  });
});
