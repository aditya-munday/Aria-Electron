/**
 * The Aria voice runtime.
 *
 * It owns the local audio pipeline and the lifecycle of voice sessions,
 * independently of any window: the Control Center, Orb and chat window consume
 * its events, but none of them owns microphone or playback state. Closing a
 * window never stops the runtime, and a cancelled voice turn never cancels an
 * AI-Engineer task (that is the supervisor's job, on the product surface).
 *
 * Activation has two independent paths:
 *   - push-to-talk begins capture immediately and never consults the wake-word
 *     detector;
 *   - wake-word detection activates a session from the local listener.
 * Typed text is a third path that bypasses capture and STT entirely.
 *
 * Ownership is single-writer: only the current session may act. A late result
 * from an older session cannot overwrite a newer interaction, because a new
 * activation either cancels the previous session (default) or is rejected, and
 * the runtime only tracks the current one.
 */

import type { AudioDevice, Microphone } from './device.js';
import type { RouteHint } from '../contract/aria-contract.js';
import { VoiceError, asVoiceError } from './errors.js';
import { VoiceEventBus, type VoiceEventListener } from './events.js';
import type { Speaker } from './playback.js';
import { createPushToTalk, type PushToTalkController, type PushToTalkIntent, type PushToTalkMode } from './push-to-talk.js';
import type { SpeechProxy } from './speech.js';
import { VoiceSession, base64ToPcm, type Orchestrator, type UtteranceBoundary } from './session.js';
import type { VoiceRuntimeConfig } from './voice-config.js';
import { validateVoiceConfig } from './voice-config.js';
import {
  createNativeWakeWordDetector,
  WakeWordController,
  type WakeWordDetector,
  type WakeWordStatus,
} from './wake-word.js';
import { WakeWordListener } from './wake-listener.js';

export interface VoiceRuntimeDiagnostics {
  readonly pushToTalkEnabled: boolean;
  readonly wakeWordEnabled: boolean;
  readonly wakeWordStatus: WakeWordStatus;
  readonly wakeWordModel: string | undefined;
  readonly wakeWordFailure: string | undefined;
  readonly vadEnabled: boolean;
  readonly noiseReductionEnabled: boolean;
  readonly listening: boolean;
  readonly sessionId: string | undefined;
  readonly sessionState: string;
  readonly lastError: { readonly kind: string; readonly message: string } | undefined;
  readonly devices: readonly AudioDevice[];
}

export interface VoiceRuntimeDeps {
  readonly config: VoiceRuntimeConfig;
  readonly microphone: Microphone;
  readonly speaker: Speaker;
  readonly speech: SpeechProxy;
  /** The orchestration seam; the Backend-mediated AI proxy satisfies it. */
  readonly orchestrator: Orchestrator;
  readonly now?: () => number;
  /**
   * The wake-word detector. Omitted means the runtime builds one from the
   * configured native engine; pass `null` to disable detection entirely.
   */
  readonly wakeWordDetector?: WakeWordDetector | null;
  readonly deviceId?: string;
}

export class VoiceRuntime {
  private config: VoiceRuntimeConfig;
  private readonly microphone: Microphone;
  private readonly speaker: Speaker;
  private readonly speech: SpeechProxy;
  private readonly orchestrator: Orchestrator;
  private readonly events = new VoiceEventBus();
  private readonly now: () => number;
  private readonly deviceId: string | undefined;
  private readonly pushToTalk: PushToTalkController;
  private readonly wakeWord: WakeWordController;
  private readonly wakeListener: WakeWordListener;

  private current: VoiceSession | undefined;
  private sessionCounter = 0;
  private lastError: VoiceError | undefined;
  private devices: readonly AudioDevice[] = [];
  private unsubscribeDeviceChange: (() => void) | undefined;

  constructor(deps: VoiceRuntimeDeps) {
    validateVoiceConfig(deps.config);
    this.config = deps.config;
    this.microphone = deps.microphone;
    this.speaker = deps.speaker;
    this.speech = deps.speech;
    this.orchestrator = deps.orchestrator;
    this.now = deps.now ?? (() => Date.now());
    this.deviceId = deps.deviceId;
    this.pushToTalk = createPushToTalk({ config: deps.config.pushToTalk, now: this.now });

    const detector = this.resolveDetector(deps);
    this.wakeWord = new WakeWordController({ detector, config: deps.config.wakeWord });
    this.wakeListener = new WakeWordListener({
      microphone: this.microphone,
      controller: this.wakeWord,
      sampleRate: this.config.sampleRate,
      frameMs: this.config.vad.frameMs,
      now: this.now,
      onActivation: (activation) => this.onWakeActivation(activation),
      onError: (error) => {
        this.lastError = error;
      },
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
    });
  }

  /** Subscribe to runtime events. Returns an unsubscribe function. */
  on(listener: VoiceEventListener): () => void {
    return this.events.on(listener);
  }

  /**
   * Learn the voices the Backend advertises and reject a configured voice it
   * cannot serve. An empty catalog cannot contradict the user's choice, so it is
   * ignored rather than treated as "nothing is offered".
   */
  async discoverVoices(voices: readonly { readonly id: string }[]): Promise<void> {
    const configured = this.config.voice;
    if (configured === undefined || voices.length === 0) return;
    if (!voices.some((voice) => voice.id === configured)) {
      this.lastError = new VoiceError(
        'invalid_configuration',
        `The voice "${configured}" is not offered by the Backend.`,
      );
    }
  }

  diagnostics(): VoiceRuntimeDiagnostics {
    return {
      pushToTalkEnabled: this.pushToTalk.isEnabled(),
      wakeWordEnabled: this.wakeWord.isEnabled(),
      wakeWordStatus: this.wakeWord.status(),
      wakeWordModel: this.wakeWord.model(),
      wakeWordFailure: this.wakeWord.failure(),
      vadEnabled: this.config.vad.enabled,
      noiseReductionEnabled: this.config.noiseReduction.enabled,
      listening: this.wakeListener.isListening(),
      sessionId: this.current?.id,
      sessionState: this.current?.currentState ?? 'idle',
      lastError:
        this.lastError !== undefined
          ? { kind: this.lastError.kind, message: this.lastError.message }
          : undefined,
      devices: this.devices,
    };
  }

  /**
   * Start the runtime: initialize wake-word detection when enabled and begin
   * listening. A wake-word failure is observable and does not prevent
   * push-to-talk.
   */
  async start(): Promise<void> {
    await this.refreshDevices();
    this.unsubscribeDeviceChange ??= this.microphone.onDeviceChange((event) => {
      this.devices = event.devices;
    });
    if (!this.wakeWord.isEnabled()) return;
    try {
      await this.wakeWord.init();
    } catch (error) {
      // Report the blocker; push-to-talk remains available.
      this.lastError = asVoiceError(error);
      return;
    }
    await this.wakeListener.start();
  }

  async stop(): Promise<void> {
    this.unsubscribeDeviceChange?.();
    this.unsubscribeDeviceChange = undefined;
    await this.wakeListener.stop();
    if (this.current !== undefined) await this.current.cancel('runtime stopped');
    this.current = undefined;
    await this.wakeWord.close().catch(() => undefined);
  }

  /** Enable or disable wake-word detection independently of push-to-talk. */
  async setWakeWordEnabled(enabled: boolean): Promise<void> {
    this.wakeWord.setEnabled(enabled);
    if (!enabled) {
      await this.wakeListener.stop();
      return;
    }
    try {
      await this.wakeWord.init();
    } catch (error) {
      this.lastError = asVoiceError(error);
      return;
    }
    if (this.current === undefined) await this.wakeListener.start();
  }

  setPushToTalkMode(mode: PushToTalkMode): void {
    this.pushToTalk.setMode(mode);
  }

  /** An explicit user action, not an agent turn: it never opens or interrupts a session. */
  async previewSpeech(input: {
    readonly text: string;
    readonly voice?: string | null;
    readonly language?: string | null;
    readonly speed?: number;
  }): Promise<void> {
    const text = input.text.trim();
    if (text === '') return;
    const speed = input.speed ?? this.config.speed;
    const audio = await this.speech.synthesize({
      text,
      voice: input.voice ?? this.config.voice ?? null,
      language: input.language ?? this.config.language ?? null,
      ...(speed !== undefined ? { speed } : {}),
      sampleRate: this.config.sampleRate,
    });
    const pcm = base64ToPcm(audio.samples_le_base64);
    if (pcm.length === 0) {
      throw new VoiceError('speech_failed', 'The Backend returned no audio to preview.');
    }
    await this.speaker.play(pcm, { sampleRate: audio.sample_rate, channels: audio.channels });
  }

  /** An in-flight session keeps its output; the next activation picks up the new values. */
  setSpeechOutput(output: {
    readonly voice?: string | null;
    readonly language?: string | null;
    readonly speed?: number;
  }): void {
    const next: VoiceRuntimeConfig = { ...this.config };
    const config = next as {
      voice?: string;
      language?: string;
      speed?: number;
    };
    if (output.voice === null) delete config.voice;
    else if (output.voice !== undefined) config.voice = output.voice;
    if (output.language === null) delete config.language;
    else if (output.language !== undefined) config.language = output.language;
    if (output.speed !== undefined) config.speed = Math.min(2, Math.max(0.5, output.speed));
    try {
      validateVoiceConfig(next);
    } catch (error) {
      this.lastError = asVoiceError(error);
      return;
    }
    this.config = next;
  }

  /** Push-to-talk: press the configured control. */
  async pushToTalkPress(): Promise<void> {
    if (!this.pushToTalk.isEnabled()) return;
    const intents = this.pushToTalk.press();
    await this.applyIntents(intents, 'push_to_talk');
  }

  /** Push-to-talk: release the configured control. */
  async pushToTalkRelease(): Promise<void> {
    if (!this.pushToTalk.isEnabled()) return;
    const intents = this.pushToTalk.release();
    await this.applyIntents(intents, 'push_to_talk');
  }

  /** Poll the max-utterance cap; call periodically while a control is held. */
  async pollPushToTalk(): Promise<void> {
    const intents = this.pushToTalk.pollMaxDuration();
    if (intents.length > 0) await this.applyIntents(intents, 'push_to_talk');
  }

  /** Run a typed turn: bypasses capture and STT, goes straight to orchestration. */
  async sendText(
    text: string,
  ): Promise<{ readonly text: string; readonly route?: RouteHint | null }> {
    const trimmed = text.trim();
    if (trimmed === '') return { text: '' };
    const session = await this.beginSession('text');
    if (session === undefined) return { text: '' };
    await session.runText(trimmed);
    this.finishSession(session);
    return {
      text: session.response ?? '',
      ...(session.route !== undefined ? { route: session.route } : {}),
    };
  }

  /** Interrupt the active session's speech/audio (barge-in). Never a task cancel. */
  async interrupt(): Promise<void> {
    if (this.current === undefined) return;
    await this.current.cancel('interrupted');
    this.current = undefined;
  }

  /** Mute capture for the current session without ending the runtime. */
  async muteCapture(): Promise<void> {
    if (this.current === undefined) return;
    await this.current.cancel('microphone muted');
    this.current = undefined;
  }

  // --- activation paths ---------------------------------------------------

  private async applyIntents(
    intents: readonly PushToTalkIntent[],
    source: 'push_to_talk',
  ): Promise<void> {
    for (const intent of intents) {
      if (intent.kind === 'begin') {
        await this.beginSession(source, 'push_to_talk');
      } else if (intent.kind === 'finalize') {
        this.current?.finalizeUtterance();
      } else {
        // An accidental short press must not leave the microphone running: end
        // the turn without submitting it.
        if (this.current !== undefined) {
          await this.current.cancel('push-to-talk press was too short');
          this.current = undefined;
        }
      }
    }
  }

  private async onWakeActivation(activation: {
    phrase: string;
    confidence: number;
    detectorId: string;
  }): Promise<void> {
    const session = await this.beginSession('wake_word');
    if (session === undefined) return;
    this.events.emit({
      type: 'wake.detected',
      sessionId: session.id,
      at: this.now(),
      phrase: activation.phrase,
      confidence: activation.confidence,
      detectorId: activation.detectorId,
    });
    void session.run('vad').then(() => this.finishSession(session));
  }

  /**
   * Open a session. Only one is current. A new activation either cancels the
   * previous session (default) or is rejected, never silently merged. In the
   * cancel policy, `beginSession` awaits the old session's teardown before the
   * new one captures, so the two never hold the microphone at once.
   */
  private async beginSession(
    source: 'push_to_talk' | 'wake_word' | 'text',
    boundary: UtteranceBoundary = 'vad',
  ): Promise<VoiceSession | undefined> {
    if (this.current !== undefined) {
      if (this.config.conflictPolicy === 'reject_new') {
        this.lastError = new VoiceError('session_conflict', 'Another voice interaction is active.');
        return undefined;
      }
      await this.current.cancel('superseded by a new activation');
      this.current = undefined;
    }
    // Wake-word listening must not hold the microphone during a session.
    await this.wakeListener.stop();

    this.sessionCounter += 1;
    const id = `voice-${this.sessionCounter}`;
    const session = new VoiceSession({
      id,
      config: this.config,
      microphone: this.microphone,
      speaker: this.speaker,
      speech: this.speech,
      orchestrator: this.orchestrator,
      events: this.events,
      now: this.now,
      ...(this.deviceId !== undefined ? { deviceId: this.deviceId } : {}),
    });
    this.current = session;
    this.events.emit({ type: 'session.started', sessionId: id, at: this.now(), source });
    if (source === 'push_to_talk') {
      void session.run(boundary).then(() => this.finishSession(session));
    }
    return session;
  }

  private finishSession(session: VoiceSession): void {
    // Only clear if this session is still the current one; a newer session has
    // already taken ownership and must not be dropped by a late finisher.
    if (this.current === session) this.current = undefined;
    void this.resumeListening();
  }

  private async resumeListening(): Promise<void> {
    if (!this.wakeWord.isEnabled()) return;
    if (this.current !== undefined) return;
    if (this.wakeListener.isListening()) return;
    this.wakeListener.reset();
    await this.wakeListener.start();
  }

  private async refreshDevices(): Promise<void> {
    try {
      this.devices = await this.microphone.listDevices();
    } catch (error) {
      this.lastError = asVoiceError(error, 'device_unavailable');
    }
  }

  private resolveDetector(deps: VoiceRuntimeDeps): WakeWordDetector {
    if (deps.wakeWordDetector === null) {
      return {
        id: 'disabled',
        status: () => 'unavailable',
        model: () => undefined,
        failure: () => undefined,
        init: async () => undefined,
        push: () => undefined,
        reset: () => undefined,
        close: async () => undefined,
      };
    }
    if (deps.wakeWordDetector !== undefined) return deps.wakeWordDetector;
    // No injected detector: build the real native integration. It fails
    // observably when the engine/model is absent, and never fabricates one.
    return createNativeWakeWordDetector({
      engineModule: process.env['ARIA_WAKE_ENGINE']?.trim() || '@picovoice/porcupine-node',
      phrase: deps.config.wakeWord.phrase,
      modelPath: process.env['ARIA_WAKE_MODEL']?.trim() || '',
      sampleRate: deps.config.sampleRate,
    });
  }
}
