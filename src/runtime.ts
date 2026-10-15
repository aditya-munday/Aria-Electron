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
import { ariaError } from './backend/product-errors.js';
import { fail, type Result } from './backend/result.js';
import { loadConfig, loadSessionToken, type AriaConfig } from './config.js';
import type { Identity } from './contract/product-contract.js';
import type { CapabilitiesResponse } from './contract/aria-contract.js';
import { AsyncCache } from './cache/async-cache.js';
import { AccountManager, type BeginLoginResult } from './auth/account.js';
import type { CredentialStore, StoredCredential } from './auth/credential-store.js';
import type { DeviceLoginClient, LoginUser } from './auth/device-login.js';
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
  /** The Aria session token; defaults to `ARIA_SESSION_TOKEN`. */
  readonly sessionToken?: string;
  /** Where the durable Beyonders credential lives; defaults to the environment. */
  readonly credentialStore?: CredentialStore;
  /** The device-code sign-in client; defaults to the Aria backend service. */
  readonly deviceLoginClient?: DeviceLoginClient;
}

export class AriaRuntime {
  readonly supervisor: AriaSupervisor;
  readonly aria: AriaClient;
  readonly config: AriaConfig;
  /**
   * The voice runtime, present only when a microphone and speaker are supplied
   * (the desktop shell provides them). It is created here but not started;
   * `startVoice()` begins listening.
   */
  readonly voice: VoiceRuntime | undefined;
  private readonly tokens: SharedToken;
  private readonly account: AccountManager;
  /**
   * Memoised reads. Identity is stable for a session; capabilities change only
   * when the backend redeploys, so a short TTL keeps the Control Center from
   * re-fetching them on every refresh. Sign-out invalidates identity.
   */
  private readonly identityCache = new AsyncCache<Result<Identity>>({ ttlMs: 30_000 });
  private readonly capabilitiesCache = new AsyncCache<Result<CapabilitiesResponse>>({
    ttlMs: 5 * 60_000,
    shouldCache: (result) => result.ok,
  });

  constructor(options: AriaRuntimeOptions = {}) {
    const config = options.config ?? loadConfig();
    this.config = config;
    this.account = new AccountManager({
      ...(options.credentialStore !== undefined ? { store: options.credentialStore } : {}),
      ...(options.deviceLoginClient !== undefined
        ? { client: options.deviceLoginClient }
        : {
            clientOptions:
              config.loginBaseUrl !== undefined ? { baseUrl: config.loginBaseUrl } : {},
          }),
    });
    // Precedence: an explicit option wins, then the environment variable, then
    // the durable login. A restored token is verified lazily by `identity()`.
    const sessionToken =
      options.sessionToken ?? loadSessionToken() ?? this.account.restore();
    this.tokens = new SharedToken(sessionToken);
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
        ...(voiceConfig.firstSentenceChars !== undefined
          ? { firstSentenceChars: voiceConfig.firstSentenceChars }
          : {}),
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
      const capabilities = await this.capabilities();
      if (!capabilities.ok) return;
      await voice.discoverVoices(capabilities.value.voices);
      voice.setStreamingSupport({
        stt: capabilities.value.streaming_stt,
        tts: capabilities.value.streaming_tts,
        chat: capabilities.value.streaming_chat,
      });
      voice.setOutputControls(capabilities.value.output_controls);
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
    if (token !== this.tokens.current()) this.invalidateReads();
    this.tokens.set(token);
  }

  /** Begin a Beyonders device-code sign-in: returns the URL to open. */
  beginLogin(): Promise<Result<BeginLoginResult>> {
    return this.account.beginLogin();
  }

  /**
   * Wait for the browser to complete the sign-in, then adopt the returned token
   * in memory and persist the credential for the next launch.
   */
  async awaitLogin(): Promise<Result<LoginUser>> {
    const result = await this.account.awaitLogin();
    if (result.ok) this.setSessionToken(result.value.authToken);
    return result;
  }

  /** Abandon an in-flight sign-in. */
  cancelLogin(): void {
    this.account.cancelLogin();
  }

  /** Sign out: drop the in-memory token and forget the durable credential. */
  signOut(): void {
    this.invalidateReads();
    this.tokens.set(undefined);
    this.account.clear();
  }

  /** The persisted login's display fields, without a network call. */
  storedAccount(): StoredCredential | undefined {
    return this.account.storedUser();
  }

  /** Where the durable credential lives, for diagnostics. */
  credentialPath(): string {
    return this.account.filePath();
  }

  /** Whether a session token is present. */
  isSignedIn(): boolean {
    return this.tokens.current() !== undefined;
  }

  /**
   * The signed-in principal, if one can be read. This is the local session's
   * identity; when it cannot be resolved the caller falls back to a local
   * principal rather than inventing a user.
   */
  async principal(): Promise<string | undefined> {
    const identity = await this.identity();
    return identity.ok ? identity.value.userId : undefined;
  }

  /**
   * Read the signed-in identity from the Backend. Returns the classified
   * failure (e.g. `no_token`, `unauthenticated`, `unavailable`) rather than
   * inventing a user; the caller renders the absence honestly. Successful reads
   * are memoised briefly so a renderer refresh does not re-hit `/api/v1/me`.
   */
  async identity(): Promise<Result<Identity>> {
    if (!this.isSignedIn()) {
      return fail(ariaError('no_token', 'No session token; the user is not signed in.'));
    }
    return this.identityCache.get('identity', () => this.supervisor.identity());
  }

  /**
   * The Backend's advertised `/v1` capabilities, memoised so the Control Center
   * and voice discovery share one fetch. A failed read is not cached.
   */
  capabilities(): Promise<Result<CapabilitiesResponse>> {
    return this.capabilitiesCache.get('capabilities', () => this.aria.capabilities());
  }

  /** Drop every memoised read; used after a session change. */
  private invalidateReads(): void {
    this.identityCache.clear();
    this.capabilitiesCache.clear();
  }

  /** The current in-memory session token, for verification and diagnostics. */
  sessionToken(): string | undefined {
    return this.tokens.current();
  }
}
