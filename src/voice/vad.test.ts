import { describe, expect, it } from 'vitest';

import { DEFAULT_VAD, createVad } from './vad.js';
import { VoiceError } from './errors.js';
import { noise, silence, tone } from './testing/fake-audio.js';

const FRAME = 320; // 20 ms at 16 kHz

function feed(vad: ReturnType<typeof createVad>, frames: Float64Array[]): string[] {
  return frames.map((frame) => vad.push(frame)).filter((event) => event !== 'none');
}

describe('VoiceActivityDetector', () => {
  it('reports onset after sustained speech and end after sustained silence', () => {
    const vad = createVad({ ...DEFAULT_VAD, floorAdaptRate: 1, initialFloorDb: -50 });
    // Establish a quiet floor.
    for (let i = 0; i < 10; i += 1) vad.push(silence(FRAME));
    // Speech for well past the onset window.
    const onset: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const event = vad.push(tone(FRAME, 0.5));
      if (event !== 'none') onset.push(event);
    }
    expect(onset).toContain('speech_start');
    expect(vad.state.inSpeech).toBe(true);
    // Silence past the end window.
    let ended = false;
    for (let i = 0; i < 60; i += 1) {
      if (vad.push(silence(FRAME)) === 'speech_end') ended = true;
    }
    expect(ended).toBe(true);
    expect(vad.state.inSpeech).toBe(false);
  });

  it('does not end the utterance for a short pause to think', () => {
    const vad = createVad({ ...DEFAULT_VAD, floorAdaptRate: 1, initialFloorDb: -50 });
    for (let i = 0; i < 10; i += 1) vad.push(silence(FRAME));
    for (let i = 0; i < 10; i += 1) vad.push(tone(FRAME, 0.5));
    expect(vad.state.inSpeech).toBe(true);
    // A 300 ms pause is shorter than the 700 ms end window.
    for (let i = 0; i < 15; i += 1) vad.push(silence(FRAME));
    expect(vad.state.inSpeech).toBe(true);
  });

  it('tolerates background noise without tripping speech onset', () => {
    const vad = createVad({ ...DEFAULT_VAD, floorAdaptRate: 1, initialFloorDb: -50 });
    let started = false;
    for (let i = 0; i < 100; i += 1) {
      if (vad.push(noise(FRAME, 0.005)) === 'speech_start') started = true;
    }
    expect(started).toBe(false);
  });

  it('forceEnd closes an open utterance', () => {
    const vad = createVad({ ...DEFAULT_VAD, floorAdaptRate: 1 });
    for (let i = 0; i < 10; i += 1) vad.push(tone(FRAME, 0.5));
    expect(vad.forceEnd()).toBe('speech_end');
    expect(vad.state.inSpeech).toBe(false);
    expect(vad.forceEnd()).toBe('none');
  });

  it('validates its configuration', () => {
    expect(() => createVad({ ...DEFAULT_VAD, frameMs: 0 })).toThrow(VoiceError);
    expect(() =>
      createVad({ ...DEFAULT_VAD, speechStartDb: 3, speechEndDb: 6 }),
    ).toThrow(VoiceError);
  });
});
