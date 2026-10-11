import { describe, expect, it } from 'vitest';

import { UtteranceAssembler, bytesToBase64, toInt16 } from './segmenter.js';

const CONFIG = { sampleRate: 16_000, channels: 1, minDurationMs: 200, maxDurationMs: 5_000 };

function frames(count: number, samples: number, value = 0.5): Float64Array[] {
  return Array.from({ length: count }, () => new Float64Array(samples).fill(value));
}

describe('UtteranceAssembler', () => {
  it('reports an empty capture without producing PCM', () => {
    const assembler = new UtteranceAssembler(CONFIG);
    expect(assembler.finish()).toEqual({ kind: 'empty' });
  });

  it('rejects a capture shorter than the minimum as too_short', () => {
    const assembler = new UtteranceAssembler(CONFIG);
    assembler.push(new Float64Array(1_600)); // 100 ms
    expect(assembler.finish().kind).toBe('too_short');
  });

  it('produces PCM for a valid utterance', () => {
    const assembler = new UtteranceAssembler(CONFIG);
    for (const frame of frames(20, 320)) assembler.push(frame); // 400 ms
    const outcome = assembler.finish();
    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') {
      expect(outcome.pcm.length).toBe(6_400);
      expect(outcome.durationMs).toBeCloseTo(400, 0);
    }
  });

  it('caps the buffer at the max duration and flags an over-long utterance', () => {
    const assembler = new UtteranceAssembler({ ...CONFIG, maxDurationMs: 1_000 });
    // Push far more than one second.
    for (let i = 0; i < 100; i += 1) assembler.push(new Float64Array(320));
    expect(assembler.overflow).toBe(true);
    expect(assembler.isFull).toBe(true);
    expect(assembler.finish().kind).toBe('too_long');
    // Memory is bounded to the cap (1000 ms of samples).
    expect(assembler.samples).toBe(16_000);
  });

  it('converts float samples to little-endian i16 with clamping', () => {
    const pcm = toInt16(new Float64Array([0, 1, -1, 2, -2, 0.5]));
    expect(Array.from(pcm)).toEqual([0, 32767, -32767, 32767, -32767, 16384]);
  });

  it('encodes PCM as base64', () => {
    const pcm = toInt16(new Float64Array([1, 2, 3, 4]));
    const base64 = bytesToBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    expect(base64).toBe(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64'));
  });
});
