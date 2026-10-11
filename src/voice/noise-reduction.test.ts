import { describe, expect, it } from 'vitest';

import { DEFAULT_NOISE_REDUCTION, createNoiseReducer } from './noise-reduction.js';
import { VoiceError } from './errors.js';
import { noise, silence, tone } from './testing/fake-audio.js';

function rms(frame: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const s = frame[i] as number;
    sum += s * s;
  }
  return Math.sqrt(sum / frame.length);
}

describe('NoiseReducer', () => {
  it('attenuates near-floor noise while keeping speech essentially intact', () => {
    const reducer = createNoiseReducer(DEFAULT_NOISE_REDUCTION, 16_000);
    // Train the floor on quiet noise.
    for (let i = 0; i < 40; i += 1) reducer.process(noise(320, 0.005, i + 1));
    const quietBefore = rms(noise(320, 0.005, 999));
    const quietAfter = rms(reducer.process(noise(320, 0.005, 999)));
    // Speech is loud and should pass at close to unity gain.
    const speechIn = tone(320, 0.6);
    const speechOut = reducer.process(speechIn);
    expect(rms(speechOut)).toBeGreaterThan(rms(speechIn) * 0.5);
    // Quiet noise is reduced.
    expect(quietAfter).toBeLessThan(quietBefore);
  });

  it('never mutes outright: attenuation is bounded', () => {
    const reducer = createNoiseReducer(
      { ...DEFAULT_NOISE_REDUCTION, maxAttenuationDb: -18 },
      16_000,
    );
    for (let i = 0; i < 40; i += 1) reducer.process(silence(320));
    const out = reducer.process(tone(320, 0.05));
    // A quiet tone is attenuated but not silenced.
    expect(rms(out)).toBeGreaterThan(0);
  });

  it('is a pass-through when disabled', () => {
    const reducer = createNoiseReducer({ ...DEFAULT_NOISE_REDUCTION, enabled: false }, 16_000);
    const frame = tone(320, 0.5);
    expect(reducer.process(frame)).toBe(frame);
  });

  it('reports clipping rather than producing out-of-range samples', () => {
    const reducer = createNoiseReducer(DEFAULT_NOISE_REDUCTION, 16_000);
    const loud = new Float64Array(320).fill(1.5);
    const out = reducer.process(loud);
    for (const sample of out) expect(Math.abs(sample)).toBeLessThanOrEqual(1);
    expect(reducer.stats.clipped).toBeGreaterThan(0);
  });

  it('validates its configuration', () => {
    expect(() =>
      createNoiseReducer({ ...DEFAULT_NOISE_REDUCTION, maxAttenuationDb: 3 }, 16_000),
    ).toThrow(VoiceError);
  });
});
