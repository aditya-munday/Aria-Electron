/**
 * The Aria integration runtime: the composition root that wires the product
 * client and the task supervisor to a configured Backend.
 *
 * The desktop shell (Electron main process, Control Center, Orb) constructs one
 * runtime at startup and uses it for the whole session. The runtime owns the
 * in-memory session token and the durable supervision store; it survives window
 * churn because it is not owned by a window.
 *
 * This is the boundary the Aria `/v1` voice surface and the UI both sit above:
 * speech turns in, requests are submitted through the Backend orchestration
 * boundary, and supervision flows back out.
 */

import { AriaClient } from './backend/aria-client.js';
import { TaskClient } from './backend/task-client.js';
import { FetchTransport, SharedToken } from './backend/transport.js';
import { loadConfig, type AriaConfig } from './config.js';
import { AriaSupervisor } from './supervisor/supervisor.js';
import { FileTaskStore, InMemoryTaskStore, type TaskStore } from './supervisor/task-store.js';
import { ChatOrchestrator } from './voice/orchestrator.js';
import { BackendSpeechProxy } from './voice/speech.js';
import type { Microphone } from './voice/device.js';
import type { Speaker } from './voice/playback.js';
import { VoiceRuntime } from './voice/voice-runtime.js';
import { loadVoiceConfig, type VoiceRuntimeConfig } from './voice/voice-config.js';
import type { WakeWordDetector } from './voice/wake-word.js';

export interface AriaRuntimeOptions {
  readonly config?: AriaConfig;
  /** A durable store path; omit for an in-memory store (tests, ephemeral). */
  readonly statePath?: string;
  readonly store?: TaskStore;
  /** Injectable fetch for tests and non-global-fetch runtimes. */
  readonly fetchImpl?: typeof fetch;
  /** Voice configuration; defaults to the environment/defaults. */
  readonly voiceConfig?: VoiceRuntimeConfig;
  /** The audio devices; the desktop shell supplies the native implementation. */
  readonly microphone?: Microphone;
  readonly speaker?: Speaker;
  /** An injected wake-word detector, or `null` to disable detection. */
  readonly wakeWordDetector?: WakeWordDetector | null;
  readonly voiceDeviceId?: string;
}

export class AriaRuntime {
  readonly supervisor: AriaSupervisor;
  readonly aria: AriaClient;
  /**
   * The voice runtime, present only when a microphone and speaker are supplied
   * (the desktop shell provides them). It is created here but not started;
   * `startVoice()` begins listening.
   */
  readonly voice: VoiceRuntime | undefined;
  private readonly tokens: SharedToken;

  constructor(options: AriaRuntimeOptions = {}) {
    const config = options.config ?? loadConfig();
    this.tokens = new SharedToken();
    const transport = new FetchTransport({
      baseUrl: config.backendBaseUrl,
      timeoutMs: config.requestTimeoutMs,
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    });
    const client = new TaskClient({ transport, tokens: this.tokens });
    this.aria = new AriaClient({ transport, tokens: this.tokens });
    const store =
      options.store ??
      (options.statePath !== undefined
        ? new FileTaskStore(options.statePath)
        : new InMemoryTaskStore());
    this.supervisor = new AriaSupervisor({ client, store });

    if (options.microphone !== undefined && options.speaker !== undefined) {
      const voiceConfig = options.voiceConfig ?? loadVoiceConfig();
      const speech = new BackendSpeechProxy(this.aria);
      const orchestrator = new ChatOrchestrator({
        client: this.aria,
        ...(voiceConfig.language !== undefined ? { language: voiceConfig.language } : {}),
      });
      this.voice = new VoiceRuntime({
        config: voiceConfig,
        microphone: options.microphone,
        speaker: options.speaker,
        speech,
        orchestrator,
        ...(options.wakeWordDetector !== undefined
          ? { wakeWordDetector: options.wakeWordDetector }
          : {}),
        ...(options.voiceDeviceId !== undefined ? { deviceId: options.voiceDeviceId } : {}),
      });
    } else {
      this.voice = undefined;
    }
  }

  /** Start the runtime: restore persisted supervision state. */
  start(): void {
    this.supervisor.start();
  }

  /** Start the voice runtime (wake-word listening), when configured. */
  async startVoice(): Promise<void> {
    const voice = this.voice;
    if (voice === undefined) return;
    await this.discoverVoices(voice);
    await voice.start();
  }

  /**
   * Reconcile the configured synthesis voice with the Backend's advertised
   * catalog. A capabilities failure is non-fatal: it is reported through the
   * runtime's error channel, never guessed around.
   */
  private async discoverVoices(voice: VoiceRuntime): Promise<void> {
    try {
      const capabilities = await this.aria.capabilities();
      if (!capabilities.ok) return;
      await voice.discoverVoices(capabilities.value.voices);
    } catch {
      // Capabilities is advisory; push-to-talk and wake word still work.
    }
  }

  /** Stop the voice runtime and release the microphone. */
  async stopVoice(): Promise<void> {
    await this.voice?.stop();
  }

  /** Set (or clear) the in-memory session token after sign-in / sign-out. */
  setSessionToken(token: string | undefined): void {
    this.tokens.set(token);
  }

  /** Whether a session token is present. */
  isSignedIn(): boolean {
    return this.tokens.current() !== undefined;
  }
}
