import { afterEach, describe, expect, it, vi } from 'vitest';

import { FrameAccumulator, VoiceCapture, resampleMono, toInt16 } from './voice.js';

describe('resampleMono', () => {
  it('returns the input unchanged when the rates match', () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    expect(resampleMono(input, 16_000, 16_000)).toBe(input);
  });

  it('halves the length when downsampling by two', () => {
    const input = new Float32Array([0, 0.5, 1, 0.5]);
    const out = resampleMono(input, 32_000, 16_000);
    expect(out).toHaveLength(2);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[1]).toBeCloseTo(1, 5);
  });

  it('linearly interpolates between samples', () => {
    const input = new Float32Array([0, 1]);
    const out = resampleMono(input, 8_000, 16_000);
    expect(out).toHaveLength(4);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[1]).toBeCloseTo(0.5, 5);
    expect(out[2]).toBeCloseTo(1, 5);
  });
});

describe('toInt16', () => {
  it('maps the extremes to the signed 16-bit range', () => {
    expect(toInt16(0)).toBe(0);
    expect(toInt16(1)).toBe(32_767);
    expect(toInt16(-1)).toBe(-32_768);
  });

  it('clamps out-of-range samples', () => {
    expect(toInt16(2)).toBe(32_767);
    expect(toInt16(-2)).toBe(-32_768);
  });
});

describe('FrameAccumulator', () => {
  it('emits fixed-size frames and holds the remainder', () => {
    const accumulator = new FrameAccumulator(4);
    expect(accumulator.push(new Float32Array([1, 2, 3]))).toHaveLength(0);
    const frames = accumulator.push(new Float32Array([4, 5, 6]));
    expect(frames).toHaveLength(1);
    expect(Array.from(frames[0] as Float32Array)).toEqual([1, 2, 3, 4]);
    const rest = accumulator.push(new Float32Array([7, 8]));
    expect(Array.from(rest[0] as Float32Array)).toEqual([5, 6, 7, 8]);
  });

  it('reset drops the partial frame', () => {
    const accumulator = new FrameAccumulator(4);
    accumulator.push(new Float32Array([1, 2, 3]));
    accumulator.reset();
    expect(accumulator.push(new Float32Array([1]))).toHaveLength(0);
  });
});

describe('VoiceCapture', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubAudio() {
    const stopTrack = vi.fn();
    const track = { stop: stopTrack };
    const stream = { getTracks: () => [track] };
    const close = vi.fn().mockResolvedValue(undefined);
    const resume = vi.fn().mockResolvedValue(undefined);
    let processor: { onaudioprocess: ((event: unknown) => void) | null } | undefined;
    class FakeAudioContext {
      sampleRate = 16_000;
      destination = {};
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createScriptProcessor() {
        processor = { onaudioprocess: null, connect: vi.fn(), disconnect: vi.fn() } as never;
        return processor;
      }
      createGain() {
        return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
      }
      resume = resume;
      close = close;
    }
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    vi.stubGlobal('AudioContext', FakeAudioContext);
    return { getUserMedia, stopTrack, close, processor: () => processor };
  }

  it('reports running once the graph is built', async () => {
    const { getUserMedia } = stubAudio();
    const statuses: string[] = [];
    const capture = new VoiceCapture(
      () => undefined,
      (state) => statuses.push(state),
    );
    await capture.start({ sampleRate: 16_000, frameMs: 20 });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(['starting', 'running']);
  });

  it('emits 16-bit frames from the audio callback', async () => {
    const audio = stubAudio();
    const chunks: Int16Array[] = [];
    const capture = new VoiceCapture(
      (pcm) => chunks.push(pcm),
      () => undefined,
    );
    await capture.start({ sampleRate: 16_000, frameMs: 20 });
    const processor = audio.processor();
    processor?.onaudioprocess?.({
      inputBuffer: { getChannelData: () => new Float32Array(320).fill(1) },
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(320);
  });

  it('reports an error when the device cannot be opened', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    vi.stubGlobal('AudioContext', vi.fn());
    const statuses: { state: string; detail?: string }[] = [];
    const capture = new VoiceCapture(
      () => undefined,
      (state, detail) => statuses.push(detail !== undefined ? { state, detail } : { state }),
    );
    await capture.start({ sampleRate: 16_000, frameMs: 20 });
    expect(statuses).toEqual([{ state: 'starting' }, { state: 'error', detail: 'denied' }]);
  });

  it('abandons a capture that is stopped while the device is opening', async () => {
    const stopTrack = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const AudioContextCtor = vi.fn();
    vi.stubGlobal('AudioContext', AudioContextCtor);
    const statuses: string[] = [];
    const capture = new VoiceCapture(
      () => undefined,
      (state) => statuses.push(state),
    );
    const starting = capture.start({ sampleRate: 16_000, frameMs: 20 });
    await capture.stop();
    await starting;
    expect(stopTrack).toHaveBeenCalledTimes(1);
    // No audio graph was built, and the trailing idle from stop is the last word.
    expect(AudioContextCtor).not.toHaveBeenCalled();
    expect(statuses[statuses.length - 1]).toBe('idle');
  });
});
