/**
 * The speech-proxy boundary: speech recognition and synthesis through the
 * Directioner Platform Backend.
 *
 * Aria never talks to a speech provider directly and never holds a provider
 * credential. This module adapts the {@link AriaClient} (`/v1`) to the narrow
 * interface the voice runtime depends on, so a test can drive the runtime with a
 * deterministic proxy while the production path is the real `/v1` contract.
 *
 * It maps the backend's error taxonomy onto the voice error taxonomy so the
 * runtime can distinguish the cases the task requires: an unauthorized request,
 * a backend outage, a provider failure, a timeout with an uncertain outcome, a
 * cancellation, and a malformed response. It never invents an endpoint and never
 * retries an uncertain request.
 */

import type { AudioPayload } from '../contract/aria-contract.js';
import type { AriaBackendError } from '../backend/product-errors.js';
import type { Result } from '../backend/result.js';
import { AriaStreamError, type AriaClient } from '../backend/aria-client.js';
import { VoiceError, type VoiceErrorKind } from './errors.js';

export interface SttResult {
  readonly text: string;
  readonly language?: string | null;
  readonly confidence?: number | null;
}

export interface TtsOptions {
  readonly language?: string | null;
  readonly voice?: string | null;
  readonly speed?: number;
  readonly sampleRate?: number;
  readonly pitch?: number;
  readonly volume?: number;
  readonly style?: string | null;
}

/** One event of a streaming transcription: `text` is the transcript so far. */
export interface SttStreamChunk {
  readonly text: string;
  readonly final: boolean;
  readonly language?: string | null;
}

export interface SttStreamInput {
  readonly audio: AudioPayload;
  readonly language?: string | null;
  readonly signal?: AbortSignal;
}

export interface TtsStreamInput {
  readonly text: string;
  readonly language?: string | null;
  readonly voice?: string | null;
  readonly speed?: number;
  readonly sampleRate?: number;
  readonly pitch?: number;
  readonly volume?: number;
  readonly style?: string | null;
  readonly signal?: AbortSignal;
}

export interface SpeechProxy {
  transcribe(input: {
    readonly audio: AudioPayload;
    readonly language?: string | null;
    readonly signal?: AbortSignal;
  }): Promise<SttResult>;
  synthesize(input: { readonly text: string } & TtsOptions): Promise<AudioPayload>;
  /** The capabilities the Backend advertises (voices, languages, streaming). */
  capabilities(): Promise<{
    readonly sttLanguages: readonly string[];
    readonly ttsLanguages: readonly string[];
    readonly voices: readonly {
      id: string;
      name: string;
      language: string;
      accent?: string;
      gender?: string;
    }[];
    readonly streamingStt: boolean;
    readonly streamingTts: boolean;
    readonly outputControls?: {
      readonly pitch: boolean;
      readonly volume: boolean;
      readonly styles: boolean;
    };
  }>;
  /**
   * A streaming transcription (`/v1/stt/stream`), when the Backend advertises
   * it. Optional so a proxy that cannot stream simply omits it; a caller reads
   * the real transcribed text from the final chunk.
   */
  transcribeStream?(input: SttStreamInput): AsyncIterable<SttStreamChunk>;
  /**
   * A streaming synthesis (`/v1/tts/stream`). Yields audio chunks in order so
   * playback can begin before the synthesis finishes; the final chunk carries no
   * audio and is not yielded.
   */
  synthesizeStream?(input: TtsStreamInput): AsyncIterable<AudioPayload>;
}

/** Adapt a backend error to a voice error, preserving the distinctions. */
export function voiceErrorFromBackend(error: AriaBackendError): VoiceError {
  let kind: VoiceErrorKind;
  switch (error.kind) {
    case 'unauthenticated':
    case 'no_token':
      kind = 'not_signed_in';
      break;
    case 'unavailable':
      // 502 is an upstream/provider failure; 503 is the backend itself.
      kind = error.status === 502 ? 'speech_failed' : 'backend_unavailable';
      break;
    case 'transport':
      // The request never reached the backend: it is unreachable, not a
      // provider failure.
      kind = 'backend_unavailable';
      break;
    case 'timeout':
      kind = 'timeout';
      break;
    case 'validation':
    case 'unprocessable':
    case 'too_large':
    case 'malformed':
      kind = 'malformed_audio';
      break;
    case 'forbidden':
    case 'rate_limited':
    case 'conflict':
    case 'not_found':
      kind = 'speech_rejected';
      break;
    default:
      kind = 'speech_failed';
  }
  return new VoiceError(kind, error.message, error);
}

function voiceErrorFromStream(error: AriaStreamError): VoiceError {
  const kind: VoiceErrorKind =
    error.kind === 'no_token' || error.kind === 'unauthenticated'
      ? 'not_signed_in'
      : error.kind === 'transport'
        ? 'backend_unavailable'
        : error.kind === 'unavailable'
          ? error.status === 502
            ? 'speech_failed'
            : 'backend_unavailable'
          : error.kind === 'timeout'
            ? 'timeout'
            : error.kind === 'forbidden' ||
                error.kind === 'rate_limited' ||
                error.kind === 'conflict' ||
                error.kind === 'not_found'
              ? 'speech_rejected'
              : error.kind === 'validation' ||
                  error.kind === 'unprocessable' ||
                  error.kind === 'too_large' ||
                  error.kind === 'malformed'
                ? 'malformed_audio'
                : 'speech_failed';
  return new VoiceError(kind, error.message, error);
}

/** The production speech proxy over the real `/v1` client. */
export class BackendSpeechProxy implements SpeechProxy {
  private readonly client: AriaClient;

  constructor(client: AriaClient) {
    this.client = client;
  }

  async transcribe(input: {
    readonly audio: AudioPayload;
    readonly language?: string | null;
    readonly signal?: AbortSignal;
  }): Promise<SttResult> {
    const result: Result<{ text: string; confidence?: number | null }> = await this.client.stt({
      audio: input.audio,
      ...(input.language !== undefined ? { language: input.language } : {}),
    });
    if (!result.ok) throw voiceErrorFromBackend(result.error);
    return {
      text: result.value.text,
      ...(result.value.confidence !== undefined ? { confidence: result.value.confidence } : {}),
    };
  }

  async synthesize(input: { readonly text: string } & TtsOptions): Promise<AudioPayload> {
    const result = await this.client.tts({
      text: input.text,
      ...(input.language !== undefined ? { language: input.language } : {}),
      ...(input.voice !== undefined ? { voice: input.voice } : {}),
      ...(input.speed !== undefined ? { speed: input.speed } : {}),
      ...(input.sampleRate !== undefined ? { sampleRate: input.sampleRate } : {}),
      ...(input.pitch !== undefined ? { pitch: input.pitch } : {}),
      ...(input.volume !== undefined ? { volume: input.volume } : {}),
      ...(input.style !== undefined ? { style: input.style } : {}),
    });
    if (!result.ok) throw voiceErrorFromBackend(result.error);
    return result.value;
  }

  async capabilities(): Promise<{
    readonly sttLanguages: readonly string[];
    readonly ttsLanguages: readonly string[];
    readonly voices: readonly {
      id: string;
      name: string;
      language: string;
      accent?: string;
      gender?: string;
    }[];
    readonly streamingStt: boolean;
    readonly streamingTts: boolean;
    readonly outputControls?: {
      readonly pitch: boolean;
      readonly volume: boolean;
      readonly styles: boolean;
    };
  }> {
    const result = await this.client.capabilities();
    if (!result.ok) throw voiceErrorFromBackend(result.error);
    const controls = result.value.output_controls;
    return {
      sttLanguages: result.value.stt_languages,
      ttsLanguages: result.value.tts_languages,
      voices: result.value.voices.map((v) => ({
        id: v.id,
        name: v.name,
        language: v.language,
        ...(v.accent !== undefined ? { accent: v.accent.tag } : {}),
        ...(v.gender !== undefined ? { gender: v.gender } : {}),
      })),
      streamingStt: result.value.streaming_stt,
      streamingTts: result.value.streaming_tts,
      ...(controls !== undefined
        ? {
            outputControls: {
              pitch: controls.pitch,
              volume: controls.volume,
              styles: controls.styles,
            },
          }
        : {}),
    };
  }

  /**
   * Stream a transcription. Each event is a partial transcript that replaces
   * the previous one; the caller takes the text from the final event. A stream
   * failure is a failed transcription, never a fabricated transcript.
   */
  async *transcribeStream(input: SttStreamInput): AsyncIterable<SttStreamChunk> {
    try {
      for await (const event of this.client.sttStream(
        {
          audio: input.audio,
          ...(input.language !== undefined ? { language: input.language } : {}),
        },
        { ...(input.signal !== undefined ? { signal: input.signal } : {}) },
      )) {
        yield {
          text: event.text,
          final: event.is_final,
          ...(event.language !== undefined ? { language: event.language } : {}),
        };
        if (event.is_final) return;
      }
    } catch (error) {
      throw streamVoiceError(error);
    }
  }

  /**
   * Stream a synthesis. Chunks are yielded as they arrive so playback can begin
   * before synthesis finishes; a zero-length or final chunk carries no audio and
   * is not yielded.
   */
  async *synthesizeStream(input: TtsStreamInput): AsyncIterable<AudioPayload> {
    let expected = 0;
    try {
      for await (const event of this.client.ttsStream(
        {
          text: input.text,
          ...(input.language !== undefined ? { language: input.language } : {}),
          ...(input.voice !== undefined ? { voice: input.voice } : {}),
          ...(input.speed !== undefined ? { speed: input.speed } : {}),
          ...(input.sampleRate !== undefined ? { sampleRate: input.sampleRate } : {}),
          ...(input.pitch !== undefined ? { pitch: input.pitch } : {}),
          ...(input.volume !== undefined ? { volume: input.volume } : {}),
          ...(input.style !== undefined ? { style: input.style } : {}),
        },
        { ...(input.signal !== undefined ? { signal: input.signal } : {}) },
      )) {
        // Chunks must arrive in a contiguous, zero-based order: a gap would
        // splice unrelated audio together, so it is a failed synthesis rather
        // than a silently reordered stream.
        if (event.sequence !== expected) {
          throw new VoiceError(
            'speech_failed',
            'The synthesis stream skipped a chunk (out-of-order sequence).',
          );
        }
        expected += 1;
        if (event.audio.samples_le_base64 !== '') yield event.audio;
        if (event.is_final) return;
      }
    } catch (error) {
      throw streamVoiceError(error);
    }
  }
}

/** Map a streaming failure onto the voice taxonomy, preserving a real error. */
function streamVoiceError(error: unknown): VoiceError {
  if (error instanceof VoiceError) return error;
  if (error instanceof AriaStreamError) return voiceErrorFromStream(error);
  return new VoiceError('speech_failed', 'The speech stream failed.', error);
}

/** Re-export for callers that build a stream and need the same mapping. */
export { voiceErrorFromStream };
