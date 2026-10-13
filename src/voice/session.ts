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
import { VoiceError, asVoiceError, isVoiceError, type VoiceErrorKind } from './errors.js';
import type { VoiceEventBus, VoiceSessionState } from './events.js';
import type { CaptureHandle, Microphone } from './device.js';
import { NoiseReducer, createNoiseReducer } from './noise-reduction.js';
import { EchoCanceller, createEchoCanceller, FarEndReference } from './echo-cancellation.js';
import { UtteranceAssembler, bytesToBase64, type UtteranceOutcome } from './segmenter.js';
import type { SpeechProxy } from './speech.js';
import type { Speaker } from './playback.js';
import { confirmationReply, interpretConfirmation, requiresConfirmation } from './os-routing.js';
import { AsyncQueue } from './stream-queue.js';
import { VoiceActivityDetector, createVad } from './vad.js';
import type { VoiceRuntimeConfig } from './voice-config.js';

/** The orchestration seam: recognized text in, an AI response out. */
export interface Orchestrator {
  respond(input: {
    readonly text: string;
    readonly sessionId: string;
    readonly signal: AbortSignal;
    readonly confirm?: boolean;
  }): Promise<{ readonly text: string; readonly route?: RouteHint | null }>;
  /**
   * Optional: an orchestrator without it is used through the batch `respond`.
   */
  respondStream?(
    input: {
      readonly text: string;
      readonly sessionId: string;
      readonly signal: AbortSignal;
      readonly confirm?: boolean;
    },
    onDelta: (delta: string) => void,
    onSentence: (sentence: string) => void,
  ): Promise<{ readonly text: string; readonly route?: RouteHint | null }>;
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
  /** Whether the Backend advertised streaming transcription / synthesis. */
  readonly streamingStt?: boolean;
  readonly streamingTts?: boolean;
  /** Whether the Backend advertised streaming chat. */
  readonly streamingChat?: boolean;
  /**
   * A system action the previous turn proposed and is awaiting confirmation
   * for. This turn answers it, so it is sent with `confirm: true`.
   */
  readonly pendingConfirmation?: RouteHint;
  /** The far-end reference of Aria's own playback, for echo cancellation. */
  readonly farEnd?: FarEndReference;
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
  private readonly streamingStt: boolean;
  private readonly streamingTts: boolean;
  private readonly streamingChat: boolean;
  private readonly farEnd: FarEndReference | undefined;

  private readonly controller = new AbortController();
  private state: VoiceSessionState = 'idle';
  private handle: CaptureHandle | undefined;
  private noise: NoiseReducer | undefined;
  private echo: EchoCanceller | undefined;
  private vad: VoiceActivityDetector | undefined;
  private assembler: UtteranceAssembler | undefined;
  private boundary: UtteranceBoundary = 'vad';
  private finalizeRequested = false;
  private utteranceResolve: (() => void) | undefined;
  private responseText: string | undefined;
  private responseRoute: RouteHint | null | undefined;
  private pendingConfirmation: RouteHint | undefined;
  private turnAudio: AsyncQueue<Int16Array> | undefined;
  private turnPlayback: Promise<void> | undefined;
  private turnPushedAudio = false;
  private readonly turnSyntheses = new Set<Promise<void>>();
  private turnStartedAt = 0;
  private firstDeltaAt: number | undefined;
  private firstAudioAt: number | undefined;
  private lastAudioAt: number | undefined;
  private maxAudioGap = 0;

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
    this.streamingStt = deps.streamingStt ?? false;
    this.streamingTts = deps.streamingTts ?? false;
    this.streamingChat = deps.streamingChat ?? false;
    this.pendingConfirmation = deps.pendingConfirmation;
    this.farEnd = deps.farEnd;
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

  /** The action a route hint proposed and is awaiting confirmation for, if any. */
  get awaitingConfirmation(): RouteHint | undefined {
    return this.pendingConfirmation;
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
      this.beginTurnMetrics();
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
      const pending = this.takePendingConfirmation();
      const spoken = await this.deliver(text, pending);
      if (spoken !== undefined && spoken !== "") await this.speak(spoken);
      this.emitTurnMetrics();
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
      this.beginTurnMetrics();
      const pending = this.takePendingConfirmation();
      const spoken = await this.deliver(text, pending);
      if (spoken !== undefined && spoken !== "") await this.speak(spoken);
      this.emitTurnMetrics();
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
    this.abandonSpeechStream();
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
    this.echo = createEchoCanceller(this.config.echoCancellation, this.config.sampleRate);
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

    // Cancel Aria's own playback echo before noise reduction; the far-end
    // reference is the PCM the speaker is playing, fed through `setFarEnd`.
    if (this.echo !== undefined && this.farEnd !== undefined) {
      this.echo.setFarEnd(this.farEnd.drain(raw.length));
    }
    const clean = this.echo !== undefined ? this.echo.process(raw) : raw;
    const denoised = noise.process(clean);
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
        // A release can arrive after capture opened but before the first frame
        // is delivered; without this the wait would never be resolved.
        if (this.finalizeRequested) resolve();
      });
    }
    this.finalizeRequested = false;
    this.utteranceResolve = undefined;
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
      if (this.streamingStt && this.speech.transcribeStream !== undefined) {
        try {
          return await this.transcribeStreaming(audio);
        } catch (error) {
          if (this.isCancelled()) throw error;
          // A stream the backend could not serve falls back to the batch
          // transcription; a stream that violated the protocol (ended without a
          // final event) does not, because batch would hide a real error.
          const kind = asVoiceError(error, 'speech_failed').kind;
          if (kind !== 'backend_unavailable' && kind !== 'timeout') throw error;
        }
      }
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

  /**
   * Stream the transcription: each partial replaces the previous transcript and
   * the final event carries the authoritative text. A stream that ends without a
   * final event is a failed transcription, never a fabricated transcript.
   */
  private async transcribeStreaming(audio: AudioPayload): Promise<string> {
    let final: string | undefined;
    const consume = async (): Promise<void> => {
      for await (const chunk of this.speech.transcribeStream!({
        audio,
        ...(this.config.language !== undefined ? { language: this.config.language } : {}),
        signal: this.controller.signal,
      })) {
        if (this.isCancelled()) return;
        if (chunk.final) {
          final = chunk.text;
          return;
        }
        // Partial transcripts are surfaced as they arrive; the authoritative
        // final transcript is emitted by the caller that consumes the result.
        this.events.emit({
          type: 'transcript',
          sessionId: this.id,
          at: this.now(),
          text: chunk.text,
          final: false,
        });
      }
    };
    await raceWithSignal(consume(), this.controller.signal, this.config.sttTimeoutMs);
    if (final === undefined) {
      throw new VoiceError('speech_failed', 'The transcription stream ended without a final transcript.');
    }
    return final;
  }

  private async respond(
    text: string,
    streamingSpeech: boolean,
    confirm?: boolean,
  ): Promise<{ readonly text: string; readonly route?: RouteHint | null } | undefined> {
    this.setState('thinking');
    try {
      const useStream = this.streamingChat && this.orchestrator.respondStream !== undefined;
      const response = await raceWithSignal(
        useStream
          ? this.respondStreaming(text, streamingSpeech, confirm)
          : this.orchestrator.respond({
              text,
              sessionId: this.id,
              signal: this.controller.signal,
              ...(confirm !== undefined ? { confirm } : {}),
            }),
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

  /**
   * One orchestration turn, shared by the voice and typed paths. A pending
   * confirmation is answered by re-sending the request with `confirm: true`; any
   * other turn is sent verbatim. The returned text is what the caller speaks on
   * the batch path; `undefined` means the streaming path already spoke it.
   *
   * A route hint is only surfaced when OS routing is enabled. A hint that
   * requires confirmation is remembered for the *next* turn and the user is
   * asked to confirm it; a hint that does not is reported but never executed.
   */
  private async deliver(
    text: string,
    pending: RouteHint | undefined,
  ): Promise<string | undefined> {
    const streamingSpeech = this.beginSpeechStream();
    // A pending proposal is answered by re-sending the request with `confirm:
    // true`, but only when the user's reply is an affirmation. A denial or an
    // unrelated reply is sent verbatim, so the Backend never executes an action
    // the user did not agree to.
    const confirm =
      pending !== undefined && interpretConfirmation(text) === 'affirm' ? true : undefined;
    let response: { readonly text: string; readonly route?: RouteHint | null } | undefined;
    try {
      response = await this.respond(text, streamingSpeech, confirm);
    } catch (error) {
      const voiceError = asVoiceError(error);
      if (streamingSpeech) this.abandonSpeechStream();
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
      return undefined;
    }
    this.ensureActive();
    if (response === undefined) {
      if (streamingSpeech) this.abandonSpeechStream();
      return undefined;
    }
    this.responseText = response.text;
    this.responseRoute = response.route;
    const proposal =
      this.config.osRouting && requiresConfirmation(response.route) ? response.route : undefined;
    this.pendingConfirmation = proposal;
    const reply =
      proposal !== undefined
        ? confirmationReply(response.text, proposal)
        : { text: response.text, spoken: undefined as string | undefined };
    if (proposal !== undefined) {
      this.events.emit({
        type: 'route.proposed',
        sessionId: this.id,
        at: this.now(),
        route: proposal,
        prompt: reply.text,
      });
    }
    this.events.emit({
      type: 'response',
      sessionId: this.id,
      at: this.now(),
      text: reply.text,
      ...(response.route !== undefined ? { route: response.route } : {}),
    });
    if (streamingSpeech) {
      // A backend question is already being spoken sentence-by-sentence; only a
      // bare yes/no cue is appended when the reply did not carry one.
      if (reply.spoken !== undefined && reply.spoken !== "") this.speakSentence(reply.spoken);
      await this.finishSpeechStream();
      return undefined;
    }
    return reply.spoken ?? reply.text;
  }

  /** Take and clear the confirmation a previous turn proposed, if any. */
  private takePendingConfirmation(): RouteHint | undefined {
    const pending = this.pendingConfirmation;
    this.pendingConfirmation = undefined;
    return pending;
  }

  /**
   * The authoritative text comes from the returned value, never from the
   * accumulated deltas, so a late or missing fragment cannot fabricate one.
   * Each completed sentence is handed to the live speech stream, so synthesis
   * begins on the first sentence rather than after the whole reply.
   */
  private async respondStreaming(
    text: string,
    streamingSpeech: boolean,
    confirm?: boolean,
  ): Promise<{ readonly text: string; readonly route?: RouteHint | null }> {
    let accumulated = '';
    const onSentence = streamingSpeech ? (sentence: string): void => this.speakSentence(sentence) : undefined;
    return this.orchestrator.respondStream!(
      {
        text,
        sessionId: this.id,
        signal: this.controller.signal,
        ...(confirm !== undefined ? { confirm } : {}),
      },
      (delta) => {
        if (this.isCancelled()) return;
        if (this.firstDeltaAt === undefined) this.firstDeltaAt = this.now();
        accumulated += delta;
        this.events.emit({
          type: 'response.delta',
          sessionId: this.id,
          at: this.now(),
          text: accumulated,
          delta,
        });
      },
      onSentence ?? (() => undefined),
    );
  }

  private async speak(text: string): Promise<void> {
    if (!this.config.speakResponses) {
      // The user disabled spoken responses; the text response stands alone.
      return;
    }
    this.setState('speaking');
    this.events.emit({ type: 'synthesis.started', sessionId: this.id, at: this.now(), text });
    if (this.streamingTts && this.speech.synthesizeStream !== undefined) {
      const audio = new AsyncQueue<Int16Array>();
      this.turnAudio = audio;
      this.turnSyntheses.clear();
      this.events.emit({ type: 'playback.started', sessionId: this.id, at: this.now() });
      this.turnPlayback = this.runSpeechStream(audio);
      this.speakSentence(text);
      await this.finishSpeechStream();
      return;
    }
    let audio: AudioPayload;
    try {
      audio = await raceWithSignal(
        this.speech.synthesize({
          text,
          ...(this.config.language !== undefined ? { language: this.config.language } : {}),
          ...(this.config.voice !== undefined ? { voice: this.config.voice } : {}),
          ...(this.config.speed !== undefined ? { speed: this.config.speed } : {}),
          ...(this.config.pitch !== undefined ? { pitch: this.config.pitch } : {}),
          ...(this.config.volume !== undefined ? { volume: this.config.volume } : {}),
          ...(this.config.style !== undefined ? { style: this.config.style } : {}),
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

  /**
   * Open the live speech stream for a turn. The device starts on the first
   * chunk, and later chunks from later sentences append in order; the stream is
   * closed once the reply's last sentence has been synthesized.
   */
  private beginSpeechStream(): boolean {
    if (!this.config.speakResponses) return false;
    if (!this.streamingTts || this.speech.synthesizeStream === undefined) return false;
    // Sentences only arrive from a streaming chat response; without it the whole
    // reply is synthesized once through the batch/streaming `speak` path.
    if (!this.streamingChat || this.orchestrator.respondStream === undefined) return false;
    const audio = new AsyncQueue<Int16Array>();
    this.turnAudio = audio;
    this.turnPushedAudio = false;
    this.turnSyntheses.clear();
    this.events.emit({ type: 'playback.started', sessionId: this.id, at: this.now() });
    this.turnPlayback = this.runSpeechStream(audio);
    return true;
  }

  private async runSpeechStream(audio: AsyncQueue<Int16Array>): Promise<void> {
    try {
      if (this.speaker.playStream !== undefined) {
        await this.speaker.playStream(audio, { sampleRate: SPEECH_SAMPLE_RATE, channels: 1 });
        return;
      }
      const collected: Int16Array[] = [];
      let total = 0;
      for await (const pcm of audio) {
        if (this.isCancelled()) return;
        collected.push(pcm);
        total += pcm.length;
      }
      if (total === 0) {
        this.fail('Synthesis returned no audio.', 'malformed_audio');
        return;
      }
      const merged = new Int16Array(total);
      let offset = 0;
      for (const pcm of collected) {
        merged.set(pcm, offset);
        offset += pcm.length;
      }
      await this.speaker.play(merged, { sampleRate: SPEECH_SAMPLE_RATE, channels: 1 });
    } catch (error) {
      const voiceError = asVoiceError(error, 'playback_failed');
      if (voiceError.kind === 'cancelled' || this.isCancelled()) {
        this.events.emit({ type: 'playback.interrupted', sessionId: this.id, at: this.now() });
        return;
      }
      const kind = voiceError.kind === 'playback_failed' ? 'speech_failed' : voiceError.kind;
      this.fail(voiceError.message, kind);
    }
  }

  /**
   * Synthesize one sentence into the live stream. A sentence that fails to
   * synthesize does not end the turn: the remaining sentences still speak, and
   * the failure is reported without erasing the text response.
   */
  private speakSentence(sentence: string): void {
    const audio = this.turnAudio;
    if (audio === undefined) return;
    const synthesis = this.synthesizeSentence(sentence, audio);
    this.turnSyntheses.add(synthesis);
    void synthesis.finally(() => this.turnSyntheses.delete(synthesis));
  }

  private async synthesizeSentence(sentence: string, audio: AsyncQueue<Int16Array>): Promise<void> {
    try {
      for await (const chunk of this.speech.synthesizeStream!({
        text: sentence,
        ...(this.config.language !== undefined ? { language: this.config.language } : {}),
        ...(this.config.voice !== undefined ? { voice: this.config.voice } : {}),
        ...(this.config.speed !== undefined ? { speed: this.config.speed } : {}),
        ...(this.config.pitch !== undefined ? { pitch: this.config.pitch } : {}),
        ...(this.config.volume !== undefined ? { volume: this.config.volume } : {}),
        ...(this.config.style !== undefined ? { style: this.config.style } : {}),
        sampleRate: SPEECH_SAMPLE_RATE,
        signal: this.controller.signal,
      })) {
        if (this.isCancelled()) return;
        const pcm = base64ToPcm(chunk.samples_le_base64);
        if (pcm.length > 0) {
          this.setState('speaking');
          this.noteAudioChunk();
          audio.push(pcm);
        }
      }
    } catch (error) {
      const voiceError = asVoiceError(error, 'speech_failed');
      if (this.isCancelled() || voiceError.kind === 'cancelled') return;
      this.events.emit({
        type: 'session.failed',
        sessionId: this.id,
        at: this.now(),
        error: voiceError.message,
        kind: voiceError.kind,
      });
    }
  }

  /** Close the stream and wait for the reply's audio to finish playing. */
  private async finishSpeechStream(): Promise<void> {
    const audio = this.turnAudio;
    if (audio === undefined) return;
    await Promise.all([...this.turnSyntheses]);
    const pushed = this.turnPushedAudio;
    audio.close();
    const playback = this.turnPlayback;
    this.turnAudio = undefined;
    this.turnPlayback = undefined;
    this.turnSyntheses.clear();
    if (playback === undefined) return;
    try {
      await raceWithSignal(playback, this.controller.signal, undefined);
      // No audio was ever pushed (a failed synthesis): a finished playback would
      // claim the user heard something they did not.
      if (pushed) this.events.emit({ type: 'playback.finished', sessionId: this.id, at: this.now() });
    } catch (error) {
      const voiceError = asVoiceError(error, 'playback_failed');
      if (voiceError.kind === 'cancelled' || this.isCancelled()) {
        this.events.emit({ type: 'playback.interrupted', sessionId: this.id, at: this.now() });
        return;
      }
      const kind = voiceError.kind === 'playback_failed' ? 'speech_failed' : voiceError.kind;
      this.fail(voiceError.message, kind);
    }
  }

  private abandonSpeechStream(): void {
    const audio = this.turnAudio;
    this.turnAudio = undefined;
    this.turnPlayback = undefined;
    this.turnSyntheses.clear();
    audio?.close();
  }

  private async releaseCapture(): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    if (handle !== undefined) {
      await handle.stop().catch(() => undefined);
    }
  }

  private classifyStageError(error: unknown, fallback: VoiceErrorKind): VoiceError {
    if (this.isCancelled()) return new VoiceError('cancelled', 'The voice turn was cancelled.');
    if (isVoiceError(error)) return error;
    return asVoiceError(error, fallback);
  }

  private setState(state: VoiceSessionState): void {
    if (this.state === state) return;
    this.state = state;
    this.events.emit({ type: 'session.state', sessionId: this.id, at: this.now(), state });
  }

  /** Mark the moment the user stopped speaking; all latency is measured from it. */
  private beginTurnMetrics(): void {
    this.turnStartedAt = this.now();
    this.firstDeltaAt = undefined;
    this.firstAudioAt = undefined;
    this.lastAudioAt = undefined;
    this.maxAudioGap = 0;
  }

  private noteAudioChunk(): void {
    const now = this.now();
    if (this.firstAudioAt === undefined) this.firstAudioAt = now;
    if (this.lastAudioAt !== undefined) {
      this.maxAudioGap = Math.max(this.maxAudioGap, now - this.lastAudioAt);
    }
    this.lastAudioAt = now;
    this.turnPushedAudio = true;
  }

  private emitTurnMetrics(): void {
    if (!this.config.debug || this.turnStartedAt === 0) return;
    this.events.emit({
      type: 'turn.metrics',
      sessionId: this.id,
      at: this.now(),
      metrics: {
        ...(this.firstDeltaAt !== undefined
          ? { firstDeltaMs: this.firstDeltaAt - this.turnStartedAt }
          : {}),
        ...(this.firstAudioAt !== undefined
          ? { firstAudioMs: this.firstAudioAt - this.turnStartedAt }
          : {}),
        ...(this.firstAudioAt !== undefined ? { streamGapMs: this.maxAudioGap } : {}),
      },
    });
  }

  private fail(error: VoiceError | string, kind?: VoiceErrorKind): void {
    const voiceError = error instanceof VoiceError ? error : new VoiceError(kind ?? 'internal', error);
    this.setState('failed');
    this.events.emit({
      type: 'session.failed',
      sessionId: this.id,
      at: this.now(),
      error: voiceError.message,
      kind: voiceError.kind,
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
