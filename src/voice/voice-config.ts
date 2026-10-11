/**
 * Voice-runtime configuration: the tunable activation, audio and speech
 * settings, with sensible defaults and validation.
 *
 * Configuration is a plain object (the app's settings layer builds it), read
 * from the environment for development. Every value is validated when the
 * runtime is built: an invalid threshold fails loudly at construction rather
 * than silently disabling a detector or producing a degenerate session.
 */

import {
  DEFAULT_NOISE_REDUCTION,
  type NoiseReductionConfig,
} from './noise-reduction.js';
import { DEFAULT_PUSH_TO_TALK, type PushToTalkConfig } from './push-to-talk.js';
import { DEFAULT_VAD, type VadConfig } from './vad.js';
import { DEFAULT_WAKE_WORD, type WakeWordConfig } from './wake-word.js';
import { DEFAULT_MIN_UTTERANCE_MS } from './segmenter.js';
import { SPEECH_SAMPLE_RATE } from './audio-format.js';
import { VoiceError } from './errors.js';

export interface VoiceRuntimeConfig {
  /** Which activation methods are available. Push-to-talk is independent. */
  readonly pushToTalk: PushToTalkConfig;
  readonly wakeWord: WakeWordConfig;
  readonly vad: VadConfig;
  readonly noiseReduction: NoiseReductionConfig;
  readonly minUtteranceMs: number;
  /** The longest utterance held in memory before it is force-finalized. */
  readonly maxUtteranceMs: number;
  /** Capture/processing sample rate; the Backend snaps synthesis rates. */
  readonly sampleRate: number;
  /** How long to wait for the STT proxy before the outcome is uncertain. */
  readonly sttTimeoutMs: number;
  /** How long to wait for the TTS proxy before the outcome is uncertain. */
  readonly ttsTimeoutMs: number;
  /** How long to wait for an AI response before the turn is abandoned. */
  readonly responseTimeoutMs: number;
  /** Whether an AI response is spoken; the user's output preference. */
  readonly speakResponses: boolean;
  /** The synthesis voice id, when the Backend advertises voices. */
  readonly voice?: string;
  readonly language?: string;
  /**
   * Voices the Backend advertised at startup, when known. A deployment that
   * advertises no voices is `[]`; an un-enriched config leaves this undefined.
   * Used to reject a configured voice the Backend cannot actually serve.
   */
  readonly voices?: readonly { readonly id: string; readonly name: string; readonly language: string }[];
  /** The policy when an activation arrives while a session is active. */
  readonly conflictPolicy: 'cancel_previous' | 'reject_new';
}

export const DEFAULT_VOICE_CONFIG: VoiceRuntimeConfig = {
  pushToTalk: DEFAULT_PUSH_TO_TALK,
  wakeWord: DEFAULT_WAKE_WORD,
  vad: DEFAULT_VAD,
  noiseReduction: DEFAULT_NOISE_REDUCTION,
  minUtteranceMs: DEFAULT_MIN_UTTERANCE_MS,
  maxUtteranceMs: 60_000,
  sampleRate: SPEECH_SAMPLE_RATE,
  sttTimeoutMs: 30_000,
  ttsTimeoutMs: 30_000,
  responseTimeoutMs: 120_000,
  speakResponses: true,
  conflictPolicy: 'cancel_previous',
};

/** Validate a configuration, throwing a `VoiceError` naming the bad value. */
export function validateVoiceConfig(config: VoiceRuntimeConfig): void {
  const positive = (name: string, value: number): void => {
    if (!(value > 0) || !Number.isFinite(value)) {
      throw new VoiceError('invalid_configuration', `${name} must be a positive number.`);
    }
  };
  positive('sampleRate', config.sampleRate);
  positive('minUtteranceMs', config.minUtteranceMs);
  positive('maxUtteranceMs', config.maxUtteranceMs);
  positive('sttTimeoutMs', config.sttTimeoutMs);
  positive('ttsTimeoutMs', config.ttsTimeoutMs);
  positive('responseTimeoutMs', config.responseTimeoutMs);
  if (config.maxUtteranceMs <= config.minUtteranceMs) {
    throw new VoiceError(
      'invalid_configuration',
      'maxUtteranceMs must exceed minUtteranceMs.',
    );
  }
  if (config.vad.frameMs <= 0) {
    throw new VoiceError('invalid_configuration', 'VAD frame size must be > 0 ms.');
  }
  if (config.voice !== undefined) {
    if (config.voice.trim() === '') {
      throw new VoiceError('invalid_configuration', 'A configured voice id must not be empty.');
    }
    const advertised = config.voices;
    // Only reject when the Backend actually advertised a catalog; an
    // un-enriched config (undefined) cannot contradict the user's choice.
    if (advertised !== undefined && advertised.length > 0) {
      const known = advertised.some((voice) => voice.id === config.voice);
      if (!known) {
        throw new VoiceError(
          'invalid_configuration',
          `The voice "${config.voice}" is not offered by the Backend.`,
        );
      }
    }
  }
}

/**
 * Build a configuration from the environment, falling back to the defaults for
 * any value that is absent. Invalid overrides are rejected by
 * {@link validateVoiceConfig} at runtime construction.
 */
export function loadVoiceConfig(env: NodeJS.ProcessEnv = process.env): VoiceRuntimeConfig {
  const bool = (name: string, fallback: boolean): boolean => {
    const raw = env[name]?.trim().toLowerCase();
    if (raw === undefined || raw === '') return fallback;
    return raw === '1' || raw === 'true' || raw === 'yes';
  };
  const num = (name: string, fallback: number): number => {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === '') return fallback;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const str = (name: string): string | undefined => {
    const raw = env[name]?.trim();
    return raw === undefined || raw === '' ? undefined : raw;
  };

  return {
    ...DEFAULT_VOICE_CONFIG,
    pushToTalk: {
      ...DEFAULT_PUSH_TO_TALK,
      enabled: bool('ARIA_PTT_ENABLED', DEFAULT_PUSH_TO_TALK.enabled),
      mode: env['ARIA_PTT_MODE']?.trim() === 'toggle' ? 'toggle' : DEFAULT_PUSH_TO_TALK.mode,
    },
    wakeWord: {
      ...DEFAULT_WAKE_WORD,
      enabled: bool('ARIA_WAKE_WORD_ENABLED', DEFAULT_WAKE_WORD.enabled),
      ...(str('ARIA_WAKE_PHRASE') !== undefined
        ? { phrase: str('ARIA_WAKE_PHRASE') as string }
        : {}),
    },
    noiseReduction: {
      ...DEFAULT_NOISE_REDUCTION,
      enabled: bool('ARIA_NOISE_REDUCTION', DEFAULT_NOISE_REDUCTION.enabled),
    },
    vad: {
      ...DEFAULT_VAD,
      enabled: bool('ARIA_VAD_ENABLED', DEFAULT_VAD.enabled),
    },
    speakResponses: bool('ARIA_SPEAK_RESPONSES', DEFAULT_VOICE_CONFIG.speakResponses),
    ...(str('ARIA_VOICE') !== undefined ? { voice: str('ARIA_VOICE') as string } : {}),
    ...(str('ARIA_LANGUAGE') !== undefined ? { language: str('ARIA_LANGUAGE') as string } : {}),
  };
}
