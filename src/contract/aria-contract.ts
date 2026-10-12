/**
 * Aria's `/v1` wire contract, as Aria-Electron speaks it.
 *
 * This is a **mirror**, not a definition. The Directioner Platform Backend is
 * the Aria `/v1` compatibility surface (its `src/modules/aria/contract.ts`,
 * with golden fixtures under `contracts/aria/`); Aria-Electron is an
 * independent native client of that surface. If this file and the served
 * contract ever disagree, the served contract wins and this file is wrong.
 *
 * Rules that are not obvious from the schemas:
 * - `contract_version` is the **integer** `1`. Aria compares it for exact
 *   equality and treats any other value as a hard error, never a silent
 *   downgrade, so a mismatch is a rejection here too.
 * - An accent is an object `{tag}`, never a bare string.
 * - Chat-stream deltas are **incremental** (append); STT-stream `text` is the
 *   transcript so far (replace). Only the final event sets `is_final: true`.
 * - Synthesis stream chunks carry a contiguous, zero-based `sequence`.
 * - The error body is flat: `{ contract_version, code, message }`.
 * - `/v1/capabilities` is unauthenticated; every other `/v1` route needs the
 *   same bearer token as the product surface.
 */

/** The only contract version Aria speaks, echoed on every response. */
export const ARIA_CONTRACT_VERSION = 1 as const;

/** The path prefix Aria's contract is served under. */
export const ARIA_PATH_PREFIX = '/v1' as const;

/** The Aria error vocabulary, mapped from HTTP status by the transport. */
export type AriaErrorCode =
  | 'invalid_request'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'auth_unavailable'
  | 'service_unavailable'
  | 'rate_limited'
  | 'insufficient_credits'
  | 'subscription_inactive'
  | 'upstream_unavailable'
  | 'cancelled'
  | 'internal_error';

export interface AriaErrorBody {
  readonly contract_version: number;
  readonly code: AriaErrorCode | (string & {});
  readonly message: string;
}

export interface Accent {
  readonly tag: string;
}

/**
 * A voice the Backend can synthesize.
 *
 * `id`, `name` and `language` are the contract's required fields. Everything
 * else is **additive**: an enriched deployment may describe a voice's `gender`,
 * `age`, `styles`, `sample_rate` and a human `description`, and a leaner one
 * may omit them. A client must render what is present and never invent the
 * rest.
 */
export interface Voice {
  readonly id: string;
  readonly name: string;
  readonly language: string;
  readonly accent?: Accent;
  readonly gender?: string;
  readonly age?: string;
  readonly styles?: readonly string[];
  readonly sample_rate?: number;
  readonly description?: string;
}

/**
 * A language Aria can recognize or speak, with a display name. Optional and
 * additive: `stt_languages` / `tts_languages` remain the bare-tag source of
 * truth, and this carries the labels when the Backend offers them.
 */
export interface Language {
  readonly tag: string;
  readonly name: string;
  readonly native_name?: string;
}

export interface CapabilitiesResponse {
  readonly contract_version: number;
  readonly backend_version: string;
  readonly stt_languages: readonly string[];
  readonly tts_languages: readonly string[];
  readonly voices: readonly Voice[];
  readonly stt_language_details?: readonly Language[];
  readonly tts_language_details?: readonly Language[];
  readonly streaming_stt: boolean;
  readonly streaming_chat: boolean;
  readonly streaming_tts: boolean;
}

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
}

export interface ChatRequest {
  readonly contract_version: number;
  readonly messages: readonly ChatMessage[];
  readonly conversation_id?: string;
  readonly language?: string;
}

export interface RouteHint {
  readonly capability: string;
  readonly requires_confirmation: boolean;
}

export interface ChatResponse {
  readonly contract_version: number;
  readonly text: string;
  readonly route?: RouteHint | null;
}

export interface ChatStreamEvent {
  readonly contract_version: number;
  readonly is_final: boolean;
  readonly delta: string;
  readonly route?: RouteHint | null;
}

/**
 * Aria's PCM audio payload: little-endian i16, base64-encoded, with the sample
 * rate and channel count stated explicitly so an unsupported shape is rejected
 * rather than guessed. Mirrors Aria's `AudioPayload`.
 */
export interface AudioPayload {
  readonly sample_rate: number;
  readonly channels: number;
  readonly samples_le_base64: string;
}

export interface SttRequest {
  readonly contract_version: number;
  readonly audio: AudioPayload;
  readonly language?: string | null;
}

export interface SttResponse {
  readonly contract_version: number;
  readonly text: string;
  readonly language?: string | null;
  readonly confidence?: number | null;
}

export interface SttStreamEvent {
  readonly contract_version: number;
  readonly is_final: boolean;
  readonly text: string;
  readonly language?: string | null;
}

export interface TtsRequest {
  readonly contract_version: number;
  readonly text: string;
  readonly language?: string | null;
  readonly voice?: string | null;
  readonly speed?: number;
  readonly sample_rate?: number;
}

export interface TtsResponse {
  readonly contract_version: number;
  readonly audio: AudioPayload;
}

export interface TtsStreamEvent {
  readonly contract_version: number;
  readonly sequence: number;
  readonly is_final: boolean;
  readonly audio: AudioPayload;
}

/** The endpoints Aria's contract exposes, relative to the `/v1` prefix. */
export const ARIA_ENDPOINTS = {
  capabilities: '/v1/capabilities',
  chat: '/v1/chat',
  chatStream: '/v1/chat/stream',
  stt: '/v1/stt',
  sttStream: '/v1/stt/stream',
  tts: '/v1/tts',
  ttsStream: '/v1/tts/stream',
} as const;

/**
 * Whether a wire value carries the one contract version this client speaks.
 *
 * Aria treats a different version as a hard error, so a client that accepted a
 * "compatible" different value would believe a request succeeded when Aria
 * would have refused it.
 */
export function isCompatibleVersion(value: unknown): boolean {
  return value === ARIA_CONTRACT_VERSION;
}
