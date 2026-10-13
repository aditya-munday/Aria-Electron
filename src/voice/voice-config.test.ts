import { describe, expect, it } from 'vitest';

import { DEFAULT_VOICE_CONFIG, loadVoiceConfig, validateVoiceConfig } from './voice-config.js';
import { VoiceError } from './errors.js';

describe('loadVoiceConfig', () => {
  it('returns the defaults for an empty environment', () => {
    const config = loadVoiceConfig({});
    expect(config.streaming).toBe(true);
    expect(config.debug).toBe(false);
    expect(config.osRouting).toBe(false);
    expect(config.firstSentenceChars).toBeUndefined();
    expect(config.endpointSilenceMs).toBe(DEFAULT_VOICE_CONFIG.endpointSilenceMs);
  });

  it('reads the streaming flag from ARIA_VOICE_STREAMING', () => {
    expect(loadVoiceConfig({ ARIA_VOICE_STREAMING: 'false' }).streaming).toBe(false);
    expect(loadVoiceConfig({ ARIA_VOICE_STREAMING: '1' }).streaming).toBe(true);
  });

  it('reads the debug flag from ARIA_VOICE_DEBUG', () => {
    expect(loadVoiceConfig({ ARIA_VOICE_DEBUG: 'true' }).debug).toBe(true);
  });

  it('keeps the OS route surface off until ARIA_OS_ROUTING enables it', () => {
    expect(loadVoiceConfig({ ARIA_OS_ROUTING: '1' }).osRouting).toBe(true);
  });

  it('tightens endpointing from ARIA_VAD_SILENCE_MS', () => {
    expect(loadVoiceConfig({ ARIA_VAD_SILENCE_MS: '300' }).endpointSilenceMs).toBe(300);
  });

  it('applies the fast-mode preset from ARIA_VOICE_FAST', () => {
    const config = loadVoiceConfig({ ARIA_VOICE_FAST: 'true' });
    expect(config.firstSentenceChars).toBe(8);
    expect(config.endpointSilenceMs).toBe(350);
  });

  it('lets an explicit silence override the fast-mode default', () => {
    const config = loadVoiceConfig({ ARIA_VOICE_FAST: 'true', ARIA_VAD_SILENCE_MS: '500' });
    expect(config.endpointSilenceMs).toBe(500);
  });
});

describe('validateVoiceConfig', () => {
  it('accepts the defaults', () => {
    expect(() => validateVoiceConfig(DEFAULT_VOICE_CONFIG)).not.toThrow();
  });

  it('rejects a non-positive endpoint silence', () => {
    expect(() =>
      validateVoiceConfig({ ...DEFAULT_VOICE_CONFIG, endpointSilenceMs: 0 }),
    ).toThrow(VoiceError);
  });

  it('rejects a max utterance no longer than the minimum', () => {
    expect(() =>
      validateVoiceConfig({ ...DEFAULT_VOICE_CONFIG, maxUtteranceMs: 100, minUtteranceMs: 100 }),
    ).toThrow(VoiceError);
  });
});
