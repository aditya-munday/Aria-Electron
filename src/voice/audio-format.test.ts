import { describe, expect, it } from 'vitest';

import {
  MAX_CHANNELS,
  assertAudioFormat,
  frameSamples,
  isSupportedAudioFormat,
  pcmDurationMs,
} from './audio-format.js';
import { VoiceError } from './errors.js';

describe('audio format', () => {
  it('accepts a supported mono 16 kHz format', () => {
    expect(isSupportedAudioFormat({ sampleRate: 16_000, channels: 1 })).toBe(true);
  });

  it('rejects an out-of-range rate and channel count', () => {
    expect(isSupportedAudioFormat({ sampleRate: 4_000, channels: 1 })).toBe(false);
    expect(isSupportedAudioFormat({ sampleRate: 16_000, channels: MAX_CHANNELS + 1 })).toBe(false);
    expect(isSupportedAudioFormat({ sampleRate: 16_000, channels: 0 })).toBe(false);
  });

  it('throws an unsupported_format VoiceError with a recoverable recovery', () => {
    try {
      assertAudioFormat({ sampleRate: 16_000, channels: 99 });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(VoiceError);
      expect((error as VoiceError).kind).toBe('unsupported_format');
      expect((error as VoiceError).recovery).toBe('reconfigure');
    }
  });

  it('computes frame sample counts from milliseconds', () => {
    expect(frameSamples(20, 16_000)).toBe(320);
    expect(frameSamples(1, 16_000)).toBe(16);
  });

  it('computes PCM duration from byte length', () => {
    // 16000 samples of mono i16 = 32000 bytes = 1000 ms.
    expect(pcmDurationMs(32_000, 16_000, 1)).toBeCloseTo(1000, 5);
  });
});
