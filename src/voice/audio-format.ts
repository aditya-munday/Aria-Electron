/**
 * Audio format handling and its bounds.
 *
 * Aria's `/v1` audio payload is little-endian i16 PCM with the sample rate and
 * channel count stated explicitly. The Backend rejects a malformed payload (bad
 * base64, an empty payload, an odd byte count) before it reaches a provider, so
 * Aria validates the same shape locally: a payload Aria knows the Backend will
 * reject must never become a billable request.
 *
 * These bounds also cap memory: a voice session must not be able to grow an
 * audio buffer without limit.
 */

import { VoiceError } from './errors.js';

export interface AudioFormat {
  readonly sampleRate: number;
  readonly channels: number;
}

/** The rate Aria captures and submits at; the Backend snaps others to it. */
export const SPEECH_SAMPLE_RATE = 16_000;

/** Rates Aria will send; the Backend snaps them to a model-supported rate. */
export const MIN_SAMPLE_RATE = 8_000;
export const MAX_SAMPLE_RATE = 48_000;
export const MAX_CHANNELS = 8;

/** The longest single utterance Aria will hold in memory: two minutes at 16 kHz. */
export const MAX_UTTERANCE_MS = 120_000;

/**
 * The largest PCM payload Aria will submit. A little-endian i16 mono payload of
 * two minutes at 16 kHz is ~3.8 MB raw; the cap leaves room for multichannel
 * while staying far under the Backend's request limits.
 */
export const MAX_PCM_BYTES = 8_000_000;

export function isSupportedAudioFormat(format: AudioFormat): boolean {
  const { sampleRate, channels } = format;
  return (
    Number.isInteger(sampleRate) &&
    sampleRate >= MIN_SAMPLE_RATE &&
    sampleRate <= MAX_SAMPLE_RATE &&
    Number.isInteger(channels) &&
    channels >= 1 &&
    channels <= MAX_CHANNELS
  );
}

export function assertAudioFormat(format: AudioFormat, context = 'audio format'): void {
  if (!isSupportedAudioFormat(format)) {
    throw new VoiceError(
      'unsupported_format',
      `Unsupported ${context}: ${format.sampleRate} Hz, ${format.channels} channel(s).`,
    );
  }
}

/** The number of samples in a frame of `frameMs` at `sampleRate`. */
export function frameSamples(frameMs: number, sampleRate: number): number {
  return Math.max(1, Math.round((frameMs * sampleRate) / 1000));
}

/**
 * The duration in milliseconds of a raw i16 PCM payload. Used to reject an
 * over-long utterance before it becomes a request.
 */
export function pcmDurationMs(byteLength: number, sampleRate: number, channels: number): number {
  const samples = byteLength / 2 / channels;
  return (samples / sampleRate) * 1000;
}
