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
    readonly voices: readonly { id: string; name: string; language: string }[];
    readonly streamingStt: boolean;
    readonly streamingTts: boolean;
  }>;
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
    error.kind === 'unauthenticated'
      ? 'not_signed_in'
      : error.kind === 'transport'
        ? 'backend_unavailable'
        : error.kind === 'unavailable'
          ? error.status === 502
            ? 'speech_failed'
            : 'backend_unavailable'
          : error.kind === 'timeout'
            ? 'timeout'
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
    });
    if (!result.ok) throw voiceErrorFromBackend(result.error);
    return result.value;
  }

  async capabilities(): Promise<{
    readonly sttLanguages: readonly string[];
    readonly ttsLanguages: readonly string[];
    readonly voices: readonly { id: string; name: string; language: string }[];
    readonly streamingStt: boolean;
    readonly streamingTts: boolean;
  }> {
    const result = await this.client.capabilities();
    if (!result.ok) throw voiceErrorFromBackend(result.error);
    return {
      sttLanguages: result.value.stt_languages,
      ttsLanguages: result.value.tts_languages,
      voices: result.value.voices.map((v) => ({
        id: v.id,
        name: v.name,
        language: v.language,
      })),
      streamingStt: result.value.streaming_stt,
      streamingTts: result.value.streaming_tts,
    };
  }
}

/** Re-export for callers that build a stream and need the same mapping. */
export { voiceErrorFromStream };
