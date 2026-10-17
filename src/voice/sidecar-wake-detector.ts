/**
 * The wake-word detector backed by the Python sidecar.
 *
 * The sidecar owns the microphone and the wake model, so this engine does not
 * receive frames: `process()` drains wake events the sidecar emitted and maps
 * them to detections. That is deliberate — it keeps the isolation boundary
 * (a native/model fault stays in the child) while presenting the same
 * {@link WakeWordEngine} seam the runtime already depends on.
 *
 * A sidecar that is down, restarting or failed reports that through the
 * detector's status and failure, so the UI tells the truth instead of pretending
 * the wake word works.
 */

import {
  EngineWakeWordDetector,
  type WakeWordDetection,
  type WakeWordDetector,
  type WakeWordEngine,
} from './wake-word.js';
import { SidecarSupervisor, type SidecarStatus } from './sidecar-supervisor.js';
import { SIDECAR_PROTOCOL_VERSION, type SidecarEvent } from './sidecar-protocol.js';

/** Default wake model bundled in the sidecar (openWakeWord's "alexa" file name). */
export const DEFAULT_SIDECAR_WAKE_MODELS = ['alexa_v0.1'];

export interface SidecarWakeDetectorOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly models?: readonly string[];
  readonly threshold?: number;
  readonly confirmFrames?: number;
  readonly cooldownMs?: number;
  readonly wakeModelDir?: string;
  readonly compute?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly supervisor?: SidecarSupervisor;
  readonly onStatus?: (status: SidecarStatus, detail?: string) => void;
}

/**
 * Adapt the supervisor to the wake-word engine seam. Wake events are queued and
 * drained one per `process()` call; a frame is ignored because capture belongs
 * to the sidecar.
 */
export class SidecarWakeEngine implements WakeWordEngine {
  readonly engineId = 'sidecar';
  readonly modelId: string;
  private readonly supervisor: SidecarSupervisor;
  private readonly models: readonly string[];
  private readonly threshold: number;
  private readonly confirmFrames: number;
  private readonly cooldownMs: number;
  private readonly wakeModelDir: string | undefined;
  private readonly compute: string;
  private readonly pending: WakeWordDetection[] = [];

  constructor(options: SidecarWakeDetectorOptions) {
    this.models = options.models ?? DEFAULT_SIDECAR_WAKE_MODELS;
    this.modelId = this.models[0] ?? 'alexa_v0.1';
    this.threshold = options.threshold ?? 0.5;
    this.confirmFrames = options.confirmFrames ?? 2;
    this.cooldownMs = options.cooldownMs ?? 2000;
    this.wakeModelDir = options.wakeModelDir;
    this.compute = options.compute ?? 'auto';
    this.supervisor =
      options.supervisor ??
      new SidecarSupervisor({
        command: options.command,
        args: options.args ?? [],
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.onStatus !== undefined ? { onStatus: options.onStatus } : {}),
      });
    // Subscribe rather than passing `onEvent`, so an injected supervisor (used
    // by tests and by a shared supervisor owned elsewhere) is observed too.
    this.supervisor.onEvent((event) => this.onEvent(event));
  }

  private onEvent(event: SidecarEvent): void {
    if (event.event === 'wake') {
      this.pending.push({ phrase: event.model, confidence: event.score });
    }
  }

  async init(): Promise<void> {
    if (this.supervisor.status() !== 'ready') {
      await this.supervisor.start();
    }
    this.supervisor.send({
      type: 'configure',
      payload: {
        protocol_version: SIDECAR_PROTOCOL_VERSION,
        wake_models: [...this.models],
        threshold: this.threshold,
        confirm_frames: this.confirmFrames,
        cooldown_ms: this.cooldownMs,
        compute: this.compute,
        ...(this.wakeModelDir !== undefined ? { wake_model_dir: this.wakeModelDir } : {}),
      },
    });
    this.supervisor.send({ type: 'arm_listen' });
  }

  process(): WakeWordDetection | undefined {
    return this.pending.shift();
  }

  async release(): Promise<void> {
    this.pending.length = 0;
    await this.supervisor.stop();
  }
}

/** Build the sidecar-backed wake detector behind the runtime's detector seam. */
export function createSidecarWakeWordDetector(
  options: SidecarWakeDetectorOptions,
): WakeWordDetector {
  return new EngineWakeWordDetector(new SidecarWakeEngine(options));
}
