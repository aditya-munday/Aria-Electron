import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ECHO_CANCELLATION,
  FarEndReference,
  createEchoCanceller,
} from './echo-cancellation.js';
import { VoiceError } from './errors.js';
import { noise, silence, tone } from './testing/fake-audio.js';

function rms(frame: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) sum += (frame[i] as number) ** 2;
  return Math.sqrt(sum / frame.length);
}

/** A synthetic echo path: the reference delayed by `delay` samples and scaled. */
function echoOf(reference: Float64Array, delay: number, gain: number): Float64Array {
  const out = new Float64Array(reference.length);
  for (let i = delay; i < reference.length; i += 1) {
    out[i] = (reference[i - delay] as number) * gain;
  }
  return out;
}

const SAMPLE_RATE = 16_000;
const FRAME = 320;

describe('EchoCanceller', () => {
  it('cancels a delayed, attenuated copy of the reference', () => {
    const canceller = createEchoCanceller(DEFAULT_ECHO_CANCELLATION, SAMPLE_RATE);
    const far = tone(FRAME, 0.5, 440, SAMPLE_RATE);
    // Adapt over many identical frames where mic == echo only.
    let lastError = FRAME;
    for (let i = 0; i < 200; i += 1) {
      canceller.setFarEnd(far);
      const echo = echoOf(far, 5, 0.4);
      lastError = rms(canceller.process(echo));
    }
    const echoRms = rms(echoOf(far, 5, 0.4));
    // The residual is materially below the raw echo.
    expect(lastError).toBeLessThan(echoRms * 0.5);
  });

  it('passes a near-end talker through when the reference is silent', () => {
    const canceller = createEchoCanceller(DEFAULT_ECHO_CANCELLATION, SAMPLE_RATE);
    const speech = tone(FRAME, 0.4, 300, SAMPLE_RATE);
    for (let i = 0; i < 20; i += 1) {
      canceller.setFarEnd(silence(FRAME));
      canceller.process(silence(FRAME));
    }
    const out = canceller.process(speech);
    expect(rms(out)).toBeGreaterThan(rms(speech) * 0.5);
  });

  it('never clips beyond [-1, 1]', () => {
    const canceller = createEchoCanceller(DEFAULT_ECHO_CANCELLATION, SAMPLE_RATE);
    canceller.setFarEnd(tone(FRAME, 1, 440, SAMPLE_RATE));
    const out = canceller.process(tone(FRAME, 1, 440, SAMPLE_RATE));
    for (let i = 0; i < out.length; i += 1) {
      expect(Math.abs(out[i] as number)).toBeLessThanOrEqual(1);
    }
  });

  it('bypasses cleanly when disabled', () => {
    const canceller = createEchoCanceller(
      { ...DEFAULT_ECHO_CANCELLATION, enabled: false },
      SAMPLE_RATE,
    );
    const frame = noise(FRAME, 0.2, 7);
    expect(canceller.process(frame)).toBe(frame);
  });

  it('validates its configuration', () => {
    expect(() =>
      createEchoCanceller({ ...DEFAULT_ECHO_CANCELLATION, filterLengthMs: 0 }, SAMPLE_RATE),
    ).toThrow(VoiceError);
    expect(() =>
      createEchoCanceller({ ...DEFAULT_ECHO_CANCELLATION, stepSize: 2 }, SAMPLE_RATE),
    ).toThrow(VoiceError);
  });
});

describe('FarEndReference', () => {
  it('drains sample-aligned frames and pads with silence when dry', () => {
    const reference = new FarEndReference(SAMPLE_RATE);
    reference.push(Int16Array.from([16_384, 8_192, 4_096]));
    const drained = reference.drain(2);
    expect(drained[0]).toBeCloseTo(0.5, 3);
    expect(drained[1]).toBeCloseTo(0.25, 3);
    const dry = reference.drain(2);
    expect(dry[0]).toBeCloseTo(0.125, 3);
    expect(dry[1]).toBe(0);
    expect(reference.depth).toBe(0);
  });

  it('bounds its backlog', () => {
    const reference = new FarEndReference(SAMPLE_RATE, 0.001);
    reference.push(new Int16Array(1000).fill(32_767));
    expect(reference.depth).toBeLessThanOrEqual(Math.round(SAMPLE_RATE * 0.001));
  });
});
