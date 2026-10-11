/**
 * The voice session: one activation through to a spoken response.
 *
 * A session owns the local pipeline for a single interaction: it opens capture,
 * runs noise reduction and VAD, assembles the utterance, submits it to the
 * Backend STT proxy, forwards the recognized text into Backend-mediated AI
 * orchestration, generates speech through the TTS proxy, and plays it locally.
 *
 * Ownership is explicit and single-writer:
 *   - The session has an id; every event it emits carries it.
 *   - `cancel()` aborts capture, the STT/TTS requests and playback promptly via
 *     an `AbortController`, so an interruption never waits for natural
 *     completion.
 *   - The runtime ensures only one session is current; a late result from an
 *     older session cannot overwrite a newer one because the session checks its
 *     own cancellation before it acts, and the runtime only accepts results from
 *     the current session.
 *
 * A session never cancels an AI-Engineer task: `cancel()` stops audio and the
 * voice turn, nothing more.
 */

import type { AudioPayload, RouteHint } from '../contract/aria-contract.js';
import { SPEECH_SAMPLE_RATE, assertAudioFormat } from './audio-format.js';
import { VoiceError, asVoiceError } from './errors.js';
import type { VoiceEventBus, VoiceSessionState } from './events.js';
import type { CaptureHandle, Microphone } from './device.js';
import { NoiseReducer, createNoiseReducer } from './noise-reduction.js';
import { UtteranceAssembler, bytesToBase64, type UtteranceOutcome } from './segmenter.js';
import type { SpeechProxy } from './speech.js';
import type { Speaker } from './playback.js';
import { VoiceActivityDetector, createVad } from './vad.js';
import type { VoiceRuntimeConfig } from './voice-config.js';

/** The orchestration seam: recognized text in, an AI response out. */
export interface Orchestrator {
  respond(input: {
    readonly text: string;
    readonly sessionId: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly text: string; readonly route?: RouteHint | null }>;
}

export interface VoiceSessionDeps {
  readonly id: string;
  readonly config: VoiceRuntimeConfig;
  readonly microphone: Microphone;
  readonly speaker: Speaker;
  readonly speech: SpeechProxy;
  readonly orchestrator: Orchestrator;
  readonly events: VoiceEventBus;
  readonly now: () => number;
  /** The device to capture from; omitted means the default device. */
  readonly deviceId?: string;
}

/** How the session decides when the utterance ends. */
export type UtteranceBoundary = 'vad' | 'push_to_talk';

export class VoiceSession {
  readonly id: string;
  private readonly config: VoiceRuntimeConfig;
  private readonly microphone: Microphone;
  private readonly speaker: Speaker;
  private readonly speech: SpeechProxy;
  private readonly orchestrator: Orchestrator;
  private readonly events: VoiceEventBus;
  private readonly now: () => number;
  private readonly deviceId: string | undefined;

  private readonly controller = new AbortController();
  private state: VoiceSessionState = 'idle';
  private handle: CaptureHandle | undefined;
  private noise: NoiseReducer | undefined;
  private vad: VoiceActivityDetector | undefined;
  private assembler: UtteranceAssembler | undefined;
  private boundary: UtteranceBoundary = 'vad';
  private finalizeRequested = false;
  private utteranceResolve: (() => void) | undefined;
  private responseText: string | undefined;
  private responseRoute: RouteHint | null | undefined;

  constructor(deps: VoiceSessionDeps) {
    this.id = deps.id;
    this.config = deps.config;
    this.microphone = deps.microphone;
    this.speaker = deps.speaker;
    this.speech = deps.speech;
    this.orchestrator = deps.orchestrator;
    this.events = deps.events;
    this.now = deps.now;
    this.deviceId = deps.deviceId;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get currentState(): VoiceSessionState {
    return this.state;
  }

  /** The AI response text, if one was produced (kept even if TTS fails). */
  get response(): string | undefined {
    return this.responseText;
  }

  get route(): RouteHint | null | undefined {
    return this.responseRoute;
  }

  isCancelled(): boolean {
    return this.controller.signal.aborted;
  }

  /**
   * Throw the abort reason if the session is no longer active. A deliberate
   * cancellation aborts with a `cancelled` error (a clean stop); a device loss
   * aborts with the device error (a real, observable failure).
   */
  private ensureActive(): void {
    if (!this.controller.signal.aborted) return;
    const reason = this.controller.signal.reason;
    if (reason instanceof VoiceError) throw reason;
    throw new VoiceError('cancelled', 'The voice turn was cancelled.');
  }

  /**
   * Run the session. `boundary` selects how the utterance ends: `vad` (wake-word
   * or text activation) or `push_to_talk` (release finalizes).
   */
  async run(boundary: UtteranceBoundary): Promise<void> {
    this.boundary = boundary;
    try {
      await this.capture();
      this.ensureActive();
      const outcome = await this.finishUtterance();
      this.ensureActive();
      if (outcome.kind !== 'ok') {
        this.emitUtteranceRejected(outcome);
        this.setState('idle');
        return;
      }
      const transcript = await this.transcribe(outcome.pcm);
      this.ensureActive();
      const text = transcript.trim();
      if (text === '') {
        // A valid but empty transcription is not an error and not a request.
        this.events.emit({ type: 'transcript', sessionId: this.id, at: this.now(), text: '', final: true });
        this.setState('idle');
        return;
      }
      this.events.emit({ type: 'transcript', sessionId: this.id, at: this.now(), text, final: true });
      let response: { readonly text: string; readonly route?: RouteHint | null } | undefined;
      try {
        response = await this.respond(text);
      } catch (error) {
        const voiceError = asVoiceError(error);
        // A device loss or an explicit cancellation aborts the whole turn; the
        // outer handler distinguishes them. Anything else is an orchestration
        // failure: the transcript is still the user's, so it is kept and the
        // failure is reported without discarding it.
        if (this.isCancelled()) throw voiceError;
        this.events.emit({
          type: 'session.failed',
          sessionId: this.id,
          at: this.now(),
          error: voiceError.message,
          kind: voiceError.kind,
        });
        this.setState('idle');
        return;
      }
      this.ensureActive();
      if (response !== undefined) {
        this.responseText = response.text;
        this.responseRoute = response.route;
        this.events.emit({
          type: 'response',
          sessionId: this.id,
          at: this.now(),
          text: response.text,
          ...(response.route !== undefined ? { route: response.route } : {}),
        });
        await this.speak(response.text);
      }
      if (!this.isCancelled()) this.setState('idle');
    } catch (error) {
      const voiceError = asVoiceError(error);
      if (voiceError.kind === 'cancelled') {
        // A deliberate cancellation is not a failure.
        this.setState('cancelled');
        return;
      }
      this.fail(voiceError);
    } finally {
      await this.releaseCapture();
    }
  }

  /** Finalize the utterance early (push-to-talk release, max duration). */
  finalizeUtterance(): void {
    this.finalizeRequested = true;
    this.utteranceResolve?.();
  }

  /**
   * Run a text turn: typed input goes directly to Backend AI orchestration,
   * bypassing microphone capture and STT entirely. Speech output still follows
   * the user's preference.
   */
  async runText(text: string): Promise<void> {
    try {
      this.events.emit({
        type: 'transcript',
        sessionId: this.id,
        at: this.now(),
        text,
        final: true,
      });
      let response: { readonly text: string; readonly route?: RouteHint | null } | undefined;
      try {
        response = await this.respond(text);
      } catch (error) {
        const voiceError = asVoiceError(error);
        if (this.isCancelled()) throw voiceError;
        this.events.emit({
          type: 'session.failed',
          sessionId: this.id,
          at: this.now(),
          error: voiceError.message,
          kind: voiceError.kind,
        });
        this.setState('idle');
        return;
      }
      if (this.isCancelled()) return;
      if (response !== undefined) {
        this.responseText = response.text;
        this.responseRoute = response.route;
        this.events.emit({
          type: 'response',
          sessionId: this.id,
          at: this.now(),
          text: response.text,
          ...(response.route !== undefined ? { route: response.route } : {}),
        });
        await this.speak(response.text);
      }
      if (!this.isCancelled()) this.setState('idle');
    } catch (error) {
      const voiceError = asVoiceError(error);
      if (voiceError.kind === 'cancelled' || this.isCancelled()) {
        this.setState('cancelled');
        return;
      }
      this.fail(voiceError);
    }
  }

  /**
   * Interrupt the session promptly: stop capture, abort the in-flight STT/TTS
   * and orchestration requests, and interrupt playback without waiting for it to
   * finish naturally.
   */
  async cancel(reason = 'cancelled'): Promise<void> {
    if (this.controller.signal.aborted) return;
    this.controller.abort(new VoiceError('cancelled', reason));
    this.finalizeRequested = true;
    this.utteranceResolve?.();
    await this.speaker.stop().catch(() => undefined);
    this.setState('cancelled');
    this.events.emit({ type: 'session.cancelled', sessionId: this.id, at: this.now(), reason });
  }

  // --- pipeline stages ----------------------------------------------------

  private async capture(): Promise<void> {
    this.setState('capturing');
    const permission = await this.microphone.permission();
    if (permission !== 'granted') {
      throw new VoiceError('permission_denied', 'Microphone access is not granted.');
    }
    assertAudioFormat({ sampleRate: this.config.sampleRate, channels: 1 }, 'capture format');
    let handle: CaptureHandle;
    try {
      handle = await this.microphone.open({
        ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
        format: { sampleRate: this.config.sampleRate, channels: 1 },
      });
    } catch (error) {
      throw asVoiceError(error, 'device_unavailable');
    }
    this.handle = handle;
    this.noise = createNoiseReducer(this.config.noiseReduction, this.config.sampleRate);
    this.vad = createVad(this.config.vad);
    this.assembler = new UtteranceAssembler({
      sampleRate: this.config.sampleRate,
      channels: 1,
      minDurationMs: this.config.minUtteranceMs,
      maxDurationMs: this.config.maxUtteranceMs,
    });

    handle.onLost((error) => {
      // A device loss mid-session is a recoverable failure: abort the turn.
      this.controller.abort(error);
      this.finalizeRequested = true;
      this.utteranceResolve?.();
    });

    handle.onFrame((frame) => this.onFrame(frame));
    try {
      await handle.start();
    } catch (error) {
      throw asVoiceError(error, 'capture_failed');
    }
    this.events.emit({
      type: 'capture.started',
      sessionId: this.id,
      at: this.now(),
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
    });
  }

  private onFrame(raw: Float64Array): void {
    if (this.isCancelled()) return;
    const assembler = this.assembler;
    const noise = this.noise;
    const vad = this.vad;
    if (assembler === undefined || noise === undefined || vad === undefined) return;

    const denoised = noise.process(raw);
    if (this.boundary === 'push_to_talk') {
      // Push-to-talk supplies the boundaries: every frame belongs to the
      // utterance. VAD still runs (for onset reporting) but does not end it.
      const event = vad.push(denoised);
      if (event === 'speech_start') {
        this.events.emit({ type: 'speech.start', sessionId: this.id, at: this.now() });
      }
      assembler.push(denoised);
    } else {
      const event = vad.push(denoised);
      if (event === 'speech_start') {
        this.events.emit({ type: 'speech.start', sessionId: this.id, at: this.now() });
        assembler.push(denoised);
      } else if (event === 'speech_end') {
        this.events.emit({
          type: 'speech.end',
          sessionId: this.id,
          at: this.now(),
          durationMs: assembler.durationMs,
        });
        this.finalizeRequested = true;
        this.utteranceResolve?.();
      } else if (vad.state.inSpeech) {
        // Ongoing speech.
        assembler.push(denoised);
      }
    }

    if (assembler.overflow || assembler.isFull) {
      this.finalizeRequested = true;
      this.utteranceResolve?.();
    }
  }

  private async finishUtterance(): Promise<UtteranceOutcome> {
    const assembler = this.assembler;
    if (assembler === undefined) return { kind: 'empty' };
    if (!this.finalizeRequested) {
      await new Promise<void>((resolve) => {
        this.utteranceResolve = resolve;
      });
    }
    this.finalizeRequested = false;
    if (this.isCancelled()) return { kind: 'empty' };
    return assembler.finish();
  }

  private emitUtteranceRejected(outcome: UtteranceOutcome): void {
    if (outcome.kind === 'ok') return;
    this.events.emit({
      type: 'utterance.rejected',
      sessionId: this.id,
      at: this.now(),
      reason: outcome.kind,
    });
  }

  private async transcribe(pcm: Int16Array): Promise<string> {
    this.setState('transcribing');
    const audio: AudioPayload = {
      sample_rate: this.config.sampleRate,
      channels: 1,
      samples_le_base64: bytesToBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)),
    };
    try {
      const result = await raceWithSignal(
        this.speech.transcribe({
          audio,
          ...(this.config.language !== undefined ? { language: this.config.language } : {}),
          signal: this.controller.signal,
        }),
        this.controller.signal,
        this.config.sttTimeoutMs,
      );
      return result.text;
    } catch (error) {
      throw this.classifyStageError(error, 'speech_failed');
    }
  }

  private async respond(
    text: string,
  ): Promise<{ readonly text: string; readonly route?: RouteHint | null } | undefined> {
    this.setState('thinking');
    try {
      const response = await raceWithSignal(
        this.orchestrator.respond({ text, sessionId: this.id, signal: this.controller.signal }),
        this.controller.signal,
        this.config.responseTimeoutMs,
      );
      return response;
    } catch (error) {
      // A failed orchestration must not fail the voice session silently: report
      // it, but a TTS failure later must still not erase a text response.
      throw this.classifyStageError(error, 'backend_unavailable');
    }
  }

  private async speak(text: string): Promise<void> {
    if (!this.config.speakResponses) {
      // The user disabled spoken responses; the text response stands alone.
      return;
    }
    this.setState('speaking');
    this.events.emit({ type: 'synthesis.started', sessionId: this.id, at: this.now(), text });
    let audio: AudioPayload;
    try {
      audio = await raceWithSignal(
        this.speech.synthesize({
          text,
          ...(this.config.language !== undefined ? { language: this.config.language } : {}),
          ...(this.config.voice !== undefined ? { voice: this.config.voice } : {}),
          sampleRate: SPEECH_SAMPLE_RATE,
        }),
        this.controller.signal,
        this.config.ttsTimeoutMs,
      );
    } catch (error) {
      const voiceError = this.classifyStageError(error, 'speech_failed');
      // TTS failure does not erase the text response; it is reported and the
      // session ends normally.
      this.events.emit({
        type: 'session.failed',
        sessionId: this.id,
        at: this.now(),
        error: voiceError.message,
        kind: voiceError.kind,
      });
      return;
    }
    if (this.isCancelled()) return;

    const pcm = base64ToPcm(audio.samples_le_base64);
    if (pcm.length === 0) {
      // Missing or invalid audio data: not proof the user heard anything.
      this.events.emit({
        type: 'session.failed',
        sessionId: this.id,
        at: this.now(),
        error: 'Synthesis returned no audio.',
        kind: 'malformed_audio',
      });
      return;
    }
    this.events.emit({ type: 'playback.started', sessionId: this.id, at: this.now() });
    try {
      await raceWithSignal(
        this.speaker.play(pcm, { sampleRate: audio.sample_rate, channels: audio.channels }),
        this.controller.signal,
        undefined,
      );
      this.events.emit({ type: 'playback.finished', sessionId: this.id, at: this.now() });
    } catch (error) {
      const voiceError = asVoiceError(error, 'playback_failed');
      if (voiceError.kind === 'cancelled' || this.isCancelled()) {
        this.events.emit({ type: 'playback.interrupted', sessionId: this.id, at: this.now() });
        return;
      }
      this.events.emit({
        type: 'session.failed',
        sessionId: this.id,
        at: this.now(),
        error: voiceError.message,
        kind: voiceError.kind,
      });
    }
  }

  private async releaseCapture(): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    if (handle !== undefined) {
      await handle.stop().catch(() => undefined);
    }
  }

  private classifyStageError(error: unknown, fallback: string): VoiceError {
    if (this.isCancelled()) return new VoiceError('cancelled', 'The voice turn was cancelled.');
    const voiceError = asVoiceError(error, 'speech_failed');
    return voiceError.kind === 'internal'
      ? new VoiceError('speech_failed', voiceError.message, error)
      : voiceError;
  }

  private setState(state: VoiceSessionState): void {
    if (this.state === state) return;
    this.state = state;
    this.events.emit({ type: 'session.state', sessionId: this.id, at: this.now(), state });
  }

  private fail(error: VoiceError): void {
    this.setState('failed');
    this.events.emit({
      type: 'session.failed',
      sessionId: this.id,
      at: this.now(),
      error: error.message,
      kind: error.kind,
    });
  }
}

/**
 * Await `promise`, but reject promptly if `signal` aborts (or the timeout
 * elapses) first. The underlying operation is expected to honor `signal` too;
 * this is the mechanism that lets an interruption stop a blocking audio
 * operation without waiting for it to finish naturally.
 *
 * A timeout rejects with a `timeout` error: the outcome is *uncertain*, so the
 * caller reconciles rather than blindly retrying.
 */
export function raceWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number | undefined,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
      if (timer !== undefined) clearTimeout(timer);
    };
    const onAbort = (): void => {
      cleanup();
      const reason = signal.reason;
      reject(
        reason instanceof VoiceError
          ? reason
          : new VoiceError('cancelled', 'The turn was cancelled.'),
      );
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        cleanup();
        reject(new VoiceError('timeout', 'The request timed out; the outcome is uncertain.'));
      }, timeoutMs);
      timer.unref?.();
    }
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/** Decode Aria's base64 little-endian i16 payload into an Int16Array. */
export function base64ToPcm(base64: string): Int16Array {
  if (base64 === '') return new Int16Array(0);
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.byteLength % 2 !== 0) return new Int16Array(0);
  // Copy into a fresh, aligned buffer so the Int16 view is valid.
  const aligned = new Uint8Array(bytes.byteLength);
  aligned.set(bytes);
  return new Int16Array(aligned.buffer, 0, bytes.byteLength / 2);
}
