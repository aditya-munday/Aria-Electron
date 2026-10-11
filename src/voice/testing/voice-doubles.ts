/**
 * Deterministic doubles for the voice runtime's seams.
 *
 * `SpeechDouble` implements the same `SpeechProxy` contract the production
 * `BackendSpeechProxy` does, so a test drives the real session pipeline and only
 * substitutes the network boundary. `FakeWakeWordDetector` implements the real
 * `WakeWordDetector` interface so the wake-word controller and listener run
 * their real code paths. `RecordingOrchestrator` is the orchestration seam.
 */

import type { AudioPayload, RouteHint } from '../../contract/aria-contract.js';
import type { SpeechProxy, SttResult, TtsOptions } from '../speech.js';
import type {
  WakeWordDetection,
  WakeWordDetector,
  WakeWordStatus,
} from '../wake-word.js';
import type { Orchestrator } from '../session.js';
import { bytesToBase64, toInt16 } from '../segmenter.js';
import { tone } from './fake-audio.js';

export interface SpeechDoubleOptions {
  readonly sttText?: string;
  readonly sttError?: Error;
  readonly ttsError?: Error;
  /** Resolve TTS with this raw PCM length; 0 means empty audio. */
  readonly ttsSamples?: number;
  /** Delay STT resolution by this many microtask ticks. */
  readonly sttDelayTicks?: number;
}

export class SpeechDouble implements SpeechProxy {
  readonly sttCalls: { audio: AudioPayload; language?: string | null }[] = [];
  readonly ttsCalls: ({ text: string } & TtsOptions)[] = [];
  private readonly options: SpeechDoubleOptions;

  constructor(options: SpeechDoubleOptions = {}) {
    this.options = options;
  }

  async transcribe(input: {
    readonly audio: AudioPayload;
    readonly language?: string | null;
    readonly signal?: AbortSignal;
  }): Promise<SttResult> {
    this.sttCalls.push({
      audio: input.audio,
      ...(input.language !== undefined ? { language: input.language } : {}),
    });
    if (this.options.sttDelayTicks !== undefined) {
      for (let i = 0; i < this.options.sttDelayTicks; i += 1) await Promise.resolve();
    }
    if (this.options.sttError !== undefined) throw this.options.sttError;
    return { text: this.options.sttText ?? '' };
  }

  async synthesize(input: { readonly text: string } & TtsOptions): Promise<AudioPayload> {
    this.ttsCalls.push(input);
    if (this.options.ttsError !== undefined) throw this.options.ttsError;
    const samples = this.options.ttsSamples ?? 320;
    const pcm = toInt16(tone(samples, 0.3));
    return {
      sample_rate: 16_000,
      channels: 1,
      samples_le_base64: bytesToBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)),
    };
  }

  async capabilities(): Promise<{
    readonly sttLanguages: readonly string[];
    readonly ttsLanguages: readonly string[];
    readonly voices: readonly { id: string; name: string; language: string }[];
    readonly streamingStt: boolean;
    readonly streamingTts: boolean;
  }> {
    return {
      sttLanguages: ['en'],
      ttsLanguages: ['en'],
      voices: [{ id: 'v1', name: 'Voice One', language: 'en' }],
      streamingStt: false,
      streamingTts: false,
    };
  }
}

export interface FakeWakeWordOptions {
  readonly id?: string;
  readonly model?: string;
  readonly initError?: Error;
  /** Detections to return, in order, one per `push` that has one. */
  readonly detections?: (WakeWordDetection | undefined)[];
  /** Always return this detection when the queue is empty. */
  readonly repeatDetection?: WakeWordDetection;
}

export class FakeWakeWordDetector implements WakeWordDetector {
  readonly id: string;
  readonly pushCount: () => number;
  private pushes = 0;
  private readonly modelId: string | undefined;
  private readonly initError: Error | undefined;
  private readonly detections: (WakeWordDetection | undefined)[];
  private readonly repeat: WakeWordDetection | undefined;
  private state: WakeWordStatus = 'unavailable';
  private failureReason: string | undefined;
  private initialized = false;

  constructor(options: FakeWakeWordOptions = {}) {
    this.id = options.id ?? 'fake-detector';
    this.modelId = options.model;
    this.initError = options.initError;
    this.detections = [...(options.detections ?? [])];
    this.repeat = options.repeatDetection;
    this.pushCount = () => this.pushes;
  }

  status(): WakeWordStatus {
    return this.state;
  }

  model(): string | undefined {
    return this.state === 'ready' ? this.modelId : undefined;
  }

  failure(): string | undefined {
    return this.failureReason;
  }

  async init(): Promise<void> {
    if (this.initError !== undefined) {
      this.state = 'failed';
      this.failureReason = this.initError.message;
      throw this.initError;
    }
    this.initialized = true;
    this.state = 'ready';
  }

  push(): WakeWordDetection | undefined {
    if (!this.initialized) return undefined;
    this.pushes += 1;
    const next = this.detections.shift();
    return next ?? this.repeat;
  }

  reset(): void {
    this.detections.length = 0;
  }

  async close(): Promise<void> {
    this.state = 'unavailable';
  }
}

export class RecordingOrchestrator implements Orchestrator {
  readonly calls: { text: string; sessionId: string }[] = [];
  private readonly respond_: (text: string) => string;
  private readonly error: Error | undefined;
  private readonly delayTicks: number;
  private readonly route: RouteHint | null | undefined;

  constructor(
    options: {
      respond?: (text: string) => string;
      error?: Error;
      delayTicks?: number;
      route?: RouteHint | null;
    } = {},
  ) {
    this.respond_ = options.respond ?? ((text) => `response:${text}`);
    this.error = options.error;
    this.delayTicks = options.delayTicks ?? 0;
    this.route = options.route;
  }

  async respond(input: {
    readonly text: string;
    readonly sessionId: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly text: string; readonly route?: RouteHint | null }> {
    this.calls.push({ text: input.text, sessionId: input.sessionId });
    for (let i = 0; i < this.delayTicks; i += 1) await Promise.resolve();
    if (this.error !== undefined) throw this.error;
    return {
      text: this.respond_(input.text),
      ...(this.route !== undefined ? { route: this.route } : {}),
    };
  }
}

/** Yield to the microtask queue `n` times so async pipeline stages advance. */
export async function tick(n = 4): Promise<void> {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

/** A controllable clock for timing-sensitive logic. */
export function manualClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}
