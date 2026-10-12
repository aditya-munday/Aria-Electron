/**
 * The Aria `/v1` client: the speech and conversation surface.
 *
 * It talks to the Directioner Platform Backend's `/v1` compatibility surface,
 * whose shapes are mirrored in `../contract/aria-contract.ts`. It is a separate
 * client from the product `TaskClient` on purpose: `/v1` has its own version
 * field, its own flat error envelope, and its own streaming framing.
 *
 * Behaviour that matters:
 *   - Every response is checked for `contract_version === 1`. A different
 *     version is a hard error, never a silent downgrade.
 *   - A `route` hint (`requires_confirmation`) is advisory. It is surfaced to
 *     the caller so it can be turned into a task through the product client; it
 *     is never treated as an authorization.
 *   - Streaming reads events incrementally and stops cleanly at the `is_final`
 *     event, so a server that keeps the socket open does not stall Aria.
 */

import { z } from 'zod';

import {
  ARIA_CONTRACT_VERSION,
  ARIA_ENDPOINTS,
  type AudioPayload,
  type CapabilitiesResponse,
  type ChatMessage,
  type ChatStreamEvent,
  type RouteHint,
  type SttStreamEvent,
  type TtsStreamEvent,
} from '../contract/aria-contract.js';
import { ariaError, kindForStatus, type AriaBackendError } from './product-errors.js';
import { readNdjson } from './ndjson.js';
import { fail, ok, type Result } from './result.js';
import { TransportFailure, type StreamingTransport, type TokenSource } from './transport.js';

const accentSchema = z.object({ tag: z.string() });
const voiceSchema = z.object({
  id: z.string(),
  name: z.string(),
  language: z.string(),
  accent: accentSchema.optional(),
  gender: z.string().optional(),
  age: z.string().optional(),
  styles: z.array(z.string()).optional(),
  sample_rate: z.number().optional(),
  description: z.string().optional(),
});
const languageSchema = z.object({
  tag: z.string(),
  name: z.string(),
  native_name: z.string().optional(),
});
const capabilitiesSchema = z.object({
  contract_version: z.literal(ARIA_CONTRACT_VERSION),
  backend_version: z.string(),
  stt_languages: z.array(z.string()),
  tts_languages: z.array(z.string()),
  voices: z.array(voiceSchema),
  stt_language_details: z.array(languageSchema).optional(),
  tts_language_details: z.array(languageSchema).optional(),
  streaming_stt: z.boolean(),
  streaming_chat: z.boolean(),
  streaming_tts: z.boolean(),
});
const routeSchema = z.object({ capability: z.string(), requires_confirmation: z.boolean() });
const chatResponseSchema = z.object({
  contract_version: z.literal(ARIA_CONTRACT_VERSION),
  text: z.string(),
  route: routeSchema.nullable().optional(),
});
const chatStreamEventSchema = z.object({
  contract_version: z.literal(ARIA_CONTRACT_VERSION),
  is_final: z.boolean(),
  delta: z.string(),
  route: routeSchema.nullable().optional(),
});
const audioPayloadSchema = z.object({
  sample_rate: z.number(),
  channels: z.number(),
  samples_le_base64: z.string(),
});
const sttResponseSchema = z.object({
  contract_version: z.literal(ARIA_CONTRACT_VERSION),
  text: z.string(),
  language: z.string().nullable().optional(),
  confidence: z.number().nullable().optional(),
});
const sttStreamEventSchema = z.object({
  contract_version: z.literal(ARIA_CONTRACT_VERSION),
  is_final: z.boolean(),
  text: z.string(),
  language: z.string().nullable().optional(),
});
const ttsResponseSchema = z.object({
  contract_version: z.literal(ARIA_CONTRACT_VERSION),
  audio: audioPayloadSchema,
});
const ttsStreamEventSchema = z.object({
  contract_version: z.literal(ARIA_CONTRACT_VERSION),
  sequence: z.number(),
  is_final: z.boolean(),
  audio: audioPayloadSchema,
});
const ariaErrorSchema = z.object({
  contract_version: z.number(),
  code: z.string(),
  message: z.string(),
});

const NDJSON = 'application/x-ndjson';

export interface AriaChatInput {
  readonly messages: readonly ChatMessage[];
  readonly conversationId?: string;
  readonly language?: string;
}

export interface AriaSttInput {
  readonly audio: AudioPayload;
  readonly language?: string | null;
}

export interface AriaTtsInput {
  readonly text: string;
  readonly language?: string | null;
  readonly voice?: string | null;
  readonly speed?: number;
  readonly sampleRate?: number;
}

export interface AriaClientOptions {
  readonly transport: StreamingTransport;
  readonly tokens: TokenSource;
}

export class AriaClient {
  private readonly transport: StreamingTransport;
  private readonly tokens: TokenSource;

  constructor(options: AriaClientOptions) {
    this.transport = options.transport;
    this.tokens = options.tokens;
  }

  /** Capabilities are public: no token is required. */
  async capabilities(): Promise<Result<CapabilitiesResponse>> {
    const raw = await this.attempt('GET', ARIA_ENDPOINTS.capabilities);
    if (!raw.ok) return raw;
    const parsed = capabilitiesSchema.safeParse(raw.value);
    if (!parsed.success) return fail(malformed('capabilities'));
    return ok(parsed.data as CapabilitiesResponse);
  }

  async chat(input: AriaChatInput): Promise<Result<{ text: string; route?: RouteHint | null }>> {
    const raw = await this.attempt('POST', ARIA_ENDPOINTS.chat, {
      contract_version: ARIA_CONTRACT_VERSION,
      messages: input.messages,
      ...(input.conversationId !== undefined ? { conversation_id: input.conversationId } : {}),
      ...(input.language !== undefined ? { language: input.language } : {}),
    });
    if (!raw.ok) return raw;
    const parsed = chatResponseSchema.safeParse(raw.value);
    if (!parsed.success) return fail(malformed('chat response'));
    return ok({
      text: parsed.data.text,
      ...(parsed.data.route !== undefined ? { route: parsed.data.route } : {}),
    });
  }

  async stt(input: AriaSttInput): Promise<Result<{ text: string; confidence?: number | null }>> {
    const raw = await this.attempt('POST', ARIA_ENDPOINTS.stt, {
      contract_version: ARIA_CONTRACT_VERSION,
      audio: input.audio,
      ...(input.language !== undefined ? { language: input.language } : {}),
    });
    if (!raw.ok) return raw;
    const parsed = sttResponseSchema.safeParse(raw.value);
    if (!parsed.success) return fail(malformed('stt response'));
    return ok({
      text: parsed.data.text,
      ...(parsed.data.confidence !== undefined ? { confidence: parsed.data.confidence } : {}),
    });
  }

  async tts(input: AriaTtsInput): Promise<Result<AudioPayload>> {
    const raw = await this.attempt('POST', ARIA_ENDPOINTS.tts, {
      contract_version: ARIA_CONTRACT_VERSION,
      text: input.text,
      ...(input.language !== undefined ? { language: input.language } : {}),
      ...(input.voice !== undefined ? { voice: input.voice } : {}),
      ...(input.speed !== undefined ? { speed: input.speed } : {}),
      ...(input.sampleRate !== undefined ? { sample_rate: input.sampleRate } : {}),
    });
    if (!raw.ok) return raw;
    const parsed = ttsResponseSchema.safeParse(raw.value);
    if (!parsed.success) return fail(malformed('tts response'));
    return ok(parsed.data.audio as AudioPayload);
  }

  /**
   * Stream a chat completion. Deltas are incremental; the stream stops at the
   * `is_final` event. `onDelta` is invoked for each non-final event.
   */
  async *chatStream(
    input: AriaChatInput,
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<ChatStreamEvent, void, void> {
    const body = {
      contract_version: ARIA_CONTRACT_VERSION,
      messages: input.messages,
      ...(input.conversationId !== undefined ? { conversation_id: input.conversationId } : {}),
      ...(input.language !== undefined ? { language: input.language } : {}),
    };
    for await (const value of this.streamJson(
      ARIA_ENDPOINTS.chatStream,
      body,
      chatStreamEventSchema,
      options.signal,
    )) {
      yield value as ChatStreamEvent;
    }
  }

  /** Stream a transcription. `text` is the transcript so far (replace). */
  async *sttStream(
    input: AriaSttInput,
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<SttStreamEvent, void, void> {
    const body = {
      contract_version: ARIA_CONTRACT_VERSION,
      audio: input.audio,
      ...(input.language !== undefined ? { language: input.language } : {}),
    };
    for await (const value of this.streamJson(
      ARIA_ENDPOINTS.sttStream,
      body,
      sttStreamEventSchema,
      options.signal,
    )) {
      yield value as SttStreamEvent;
    }
  }

  /** Stream synthesis. Chunks carry a contiguous, zero-based `sequence`. */
  async *ttsStream(
    input: AriaTtsInput,
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<TtsStreamEvent, void, void> {
    const body = {
      contract_version: ARIA_CONTRACT_VERSION,
      text: input.text,
      ...(input.language !== undefined ? { language: input.language } : {}),
      ...(input.voice !== undefined ? { voice: input.voice } : {}),
      ...(input.speed !== undefined ? { speed: input.speed } : {}),
      ...(input.sampleRate !== undefined ? { sample_rate: input.sampleRate } : {}),
    };
    for await (const value of this.streamJson(
      ARIA_ENDPOINTS.ttsStream,
      body,
      ttsStreamEventSchema,
      options.signal,
    )) {
      yield value as TtsStreamEvent;
    }
  }

  // --- internals ----------------------------------------------------------

  private async attempt(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<Result<unknown>> {
    const token = this.tokens.current();
    // Capabilities is the one unauthenticated route.
    if (token === undefined && path !== ARIA_ENDPOINTS.capabilities) {
      return fail(ariaError('no_token', 'Sign in to reach the Directioner backend.'));
    }
    let response;
    try {
      response = await this.transport.request({
        method,
        path,
        token: token ?? '',
        ...(body !== undefined ? { body } : {}),
      });
    } catch (error) {
      if (error instanceof TransportFailure) return fail(ariaError('transport', error.message));
      return fail(ariaError('transport', 'The Aria request failed.'));
    }
    if (response.status >= 200 && response.status < 300) return ok(response.body);
    return fail(classifyAriaError(response.status, response.body));
  }

  private async *streamJson<T extends z.ZodTypeAny>(
    path: string,
    body: unknown,
    schema: T,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<z.infer<T>, void, void> {
    const token = this.tokens.current();
    if (token === undefined) {
      throw new AriaStreamError('no_token', 'Sign in to reach the Directioner backend.');
    }
    let response;
    try {
      response = await this.transport.stream({
        method: 'POST',
        path,
        body,
        token,
        accept: NDJSON,
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (error) {
      if (error instanceof TransportFailure) throw new AriaStreamError('transport', error.message);
      throw new AriaStreamError('transport', 'The Aria stream failed.');
    }
    if (response.status < 200 || response.status >= 300 || response.body === null) {
      throw new AriaStreamError(
        kindForStatus(response.status),
        `The Aria stream was rejected (${response.status}).`,
        response.status,
      );
    }
    for await (const line of readNdjson(response.body)) {
      if (line.trim() === '') continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new AriaStreamError('malformed', 'The Aria stream sent a malformed event.');
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        throw new AriaStreamError('malformed', 'The Aria stream sent an unexpected event.');
      }
      yield parsed.data as z.infer<T>;
      // Stop at the terminal event so a server that keeps the socket open does
      // not stall the consumer.
      if ((parsed.data as { is_final?: boolean }).is_final === true) return;
    }
  }
}

/** A failure raised from within a stream (surfaced to the caller). */
export class AriaStreamError extends Error {
  constructor(
    readonly kind: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AriaStreamError';
  }
}

function malformed(what: string): AriaBackendError {
  return ariaError('malformed', `The backend returned a malformed ${what}.`);
}

function classifyAriaError(status: number, body: unknown): AriaBackendError {
  const parsed = ariaErrorSchema.safeParse(body);
  const message = parsed.success
    ? parsed.data.message
    : `The Aria surface rejected the request (${status}).`;
  return ariaError(kindForStatus(status), message, { status });
}
