/**
 * Local wake-word detection.
 *
 * Wake-word recognition runs entirely locally and must never require the
 * Backend. This module is the integration boundary plus the controller around
 * it:
 *
 *   - {@link WakeWordEngine} is the low-level seam a *real* detector engine
 *     implements: initialize a model, feed frames, return a keyword index and a
 *     confidence. It is deliberately tiny so a native engine (Porcupine,
 *     openWakeWord, …) can sit behind it without leaking its API upward.
 *   - {@link EngineWakeWordDetector} adapts an engine to the runtime's
 *     {@link WakeWordDetector} interface, owning model init, frame input,
 *     confidence handling, lifecycle and failure reporting.
 *   - {@link createNativeWakeWordDetector} loads the configured engine module
 *     dynamically. When the engine or its model file is absent it fails
 *     observably (never silently) and reports the precise blocker; it never
 *     substitutes a keyword-matching stub.
 *   - {@link WakeWordController} applies the enable/disable policy, the phrase
 *     mapping, the confidence floor and the duplicate-detection cooldown. The
 *     wake word only *activates* a session; it is never itself treated as the
 *     user's request.
 *
 * The detector is one activation path; push-to-talk is a separate one and does
 * not consult this module at all.
 */

import { VoiceError } from './errors.js';

export type WakeWordStatus = 'unavailable' | 'loading' | 'ready' | 'failed';

export interface WakeWordDetection {
  readonly phrase: string;
  readonly confidence: number;
}

/** A real detector engine. The runtime never depends on a concrete engine. */
export interface WakeWordEngine {
  /** A human-readable engine identifier, e.g. `porcupine`. */
  readonly engineId: string;
  /** The loaded model/parameter identifier, for diagnostics. */
  readonly modelId: string;
  /** Load and prepare the model. Must be idempotent. */
  init(): Promise<void>;
  /**
   * Process one frame. Returns a detection when the wake phrase was heard, or
   * `undefined`. The engine maps its keyword index to a phrase itself.
   */
  process(frame: Float64Array): WakeWordDetection | undefined;
  /** Release engine resources. */
  release(): Promise<void>;
}

/** The boundary the voice runtime depends on. */
export interface WakeWordDetector {
  readonly id: string;
  status(): WakeWordStatus;
  /** The loaded model identifier, or `undefined` before init / on failure. */
  model(): string | undefined;
  /** A precise, user-safe description of the last failure, if any. */
  failure(): string | undefined;
  init(): Promise<void>;
  /** Feed one frame; returns a detection or `undefined`. */
  push(frame: Float64Array): WakeWordDetection | undefined;
  reset(): void;
  close(): Promise<void>;
}

/**
 * Adapt a {@link WakeWordEngine} to the runtime's detector interface. It owns
 * the lifecycle: a frame pushed before `init()` is ignored, an init failure
 * latches the detector into `failed` (with the reason), and a processing throw
 * is contained so a detector fault cannot crash the audio callback.
 */
export class EngineWakeWordDetector implements WakeWordDetector {
  readonly id: string;
  private readonly engine: WakeWordEngine;
  private state: WakeWordStatus = 'unavailable';
  private lastFailure: string | undefined;

  constructor(engine: WakeWordEngine) {
    this.engine = engine;
    this.id = engine.engineId;
  }

  status(): WakeWordStatus {
    return this.state;
  }

  model(): string | undefined {
    return this.state === 'ready' ? this.engine.modelId : undefined;
  }

  failure(): string | undefined {
    return this.lastFailure;
  }

  async init(): Promise<void> {
    if (this.state === 'ready') return;
    this.state = 'loading';
    this.lastFailure = undefined;
    try {
      await this.engine.init();
      this.state = 'ready';
    } catch (error) {
      this.state = 'failed';
      this.lastFailure = error instanceof Error ? error.message : 'wake-word model failed to load';
      throw new VoiceError('internal', this.lastFailure, error);
    }
  }

  push(frame: Float64Array): WakeWordDetection | undefined {
    if (this.state !== 'ready') return undefined;
    try {
      return this.engine.process(frame);
    } catch (error) {
      // A detector fault is observable but not fatal: latch to failed so the
      // runtime can fall back to push-to-talk.
      this.state = 'failed';
      this.lastFailure = error instanceof Error ? error.message : 'wake-word processing failed';
      return undefined;
    }
  }

  reset(): void {
    if (this.state === 'ready') {
      // Engines are stateful (buffered history); a reset is a re-init of the
      // streaming state, not a model reload. init() is async, so latch a
      // rejected re-init instead of leaving an unhandled rejection behind.
      void this.engine.init().catch(() => {
        this.state = 'failed';
      });
    }
  }

  async close(): Promise<void> {
    try {
      await this.engine.release();
    } finally {
      this.state = 'unavailable';
    }
  }
}

export interface NativeWakeWordConfig {
  /** The engine module to import, e.g. `@picovoice/porcupine-node`. */
  readonly engineModule: string;
  /** The activation phrase the model is trained for. */
  readonly phrase: string;
  /** Path to the model/parameter file the engine loads. */
  readonly modelPath: string;
  /** Access-key env var name, when the engine requires one. */
  readonly accessKeyEnv?: string;
  readonly sampleRate: number;
}

/**
 * Build a detector backed by a real, native engine, loaded dynamically.
 *
 * The engine module and its model file are *not* vendored with Aria: they are a
 * native dependency and a trained model. When either is missing, `init()` fails
 * with a precise, user-safe reason (the module or the model file) rather than
 * pretending detection works. This is the real integration; verifying it against
 * a live microphone requires the native dependency and model to be present.
 */
export function createNativeWakeWordDetector(config: NativeWakeWordConfig): WakeWordDetector {
  const engine: WakeWordEngine = {
    engineId: config.engineModule,
    modelId: config.modelPath,
    async init(): Promise<void> {
      let module: unknown;
      try {
        module = await import(/* @vite-ignore */ config.engineModule);
      } catch (error) {
        throw new VoiceError(
          'device_unavailable',
          `Wake-word engine "${config.engineModule}" is not installed.`,
          error,
        );
      }
      const factory = (module as { createWakeWordEngine?: (c: NativeWakeWordConfig) => WakeWordEngine })
        .createWakeWordEngine;
      if (typeof factory !== 'function') {
        throw new VoiceError(
          'internal',
          `Wake-word engine "${config.engineModule}" does not export createWakeWordEngine.`,
        );
      }
      // A concrete engine module owns its own model loading and keyword mapping.
      Object.assign(engine, factory(config));
    },
    process(): WakeWordDetection | undefined {
      return undefined;
    },
    async release(): Promise<void> {
      // Nothing to release before a concrete engine has been assigned.
    },
  };
  return new EngineWakeWordDetector(engine);
}

export interface WakeWordConfig {
  readonly enabled: boolean;
  readonly phrase: string;
  /** Detections below this confidence are ignored. */
  readonly minConfidence: number;
  /** Suppress a repeated detection within this window, in ms. */
  readonly cooldownMs: number;
}

export const DEFAULT_WAKE_WORD: WakeWordConfig = {
  enabled: false,
  phrase: 'hey aria',
  minConfidence: 0.5,
  cooldownMs: 1_500,
};

export interface WakeWordActivation {
  readonly phrase: string;
  readonly confidence: number;
  readonly detectorId: string;
  /** Milliseconds since the previous activation (or since start). */
  readonly sinceLastActivationMs: number;
}

/**
 * The enable/disable policy, confidence floor and duplicate-detection cooldown.
 * It is independent of push-to-talk: disabling wake-word detection leaves
 * push-to-talk and text chat fully working.
 */
export class WakeWordController {
  private readonly detector: WakeWordDetector;
  private readonly config: WakeWordConfig;
  private enabled: boolean;
  private lastActivationMs: number | undefined;

  constructor(deps: { detector: WakeWordDetector; config: WakeWordConfig }) {
    this.detector = deps.detector;
    this.config = deps.config;
    this.enabled = deps.config.enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  status(): WakeWordStatus {
    return this.detector.status();
  }

  model(): string | undefined {
    return this.detector.model();
  }

  failure(): string | undefined {
    return this.detector.failure();
  }

  async init(): Promise<void> {
    if (!this.enabled) return;
    await this.detector.init();
  }

  /**
   * Feed one frame. Returns an activation only when detection is enabled, the
   * detector is ready, the confidence clears the floor, and the cooldown has
   * elapsed. A sustained detection therefore produces one activation, not a
   * stream of sessions.
   */
  push(frame: Float64Array, nowMs: number): WakeWordActivation | undefined {
    if (!this.enabled) return undefined;
    if (this.detector.status() !== 'ready') return undefined;
    const detection = this.detector.push(frame);
    if (detection === undefined) return undefined;
    if (detection.confidence < this.config.minConfidence) return undefined;
    if (
      this.lastActivationMs !== undefined &&
      nowMs - this.lastActivationMs < this.config.cooldownMs
    ) {
      return undefined;
    }
    const since = this.lastActivationMs === undefined ? nowMs : nowMs - this.lastActivationMs;
    this.lastActivationMs = nowMs;
    return {
      phrase: detection.phrase,
      confidence: detection.confidence,
      detectorId: this.detector.id,
      sinceLastActivationMs: since,
    };
  }

  reset(): void {
    this.detector.reset();
  }

  async close(): Promise<void> {
    await this.detector.close();
  }
}
