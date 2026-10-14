/**
 * The real wake-word detector: the VoxRT on-device engine.
 *
 * VoxRT ships a WebAssembly runtime plus a trained `.vxrt` model and detects
 * the phrase "Hey Assistant" on 16 kHz mono audio, entirely on-device: no
 * network, no API key, no native build. It is the only detector this module
 * wraps, so the runtime never falls back to a hand-tuned heuristic.
 *
 * The engine is a browser SDK, but its WebAssembly core runs anywhere V8 does,
 * including the Electron main process. Both the renderer (which owns the live
 * microphone stream) and the main process (which can drive the command-line
 * recorder) construct this same adapter over the same model bytes, so the two
 * paths detect identically.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { VoiceError } from './errors.js';
import { EngineWakeWordDetector, type WakeWordDetection, type WakeWordDetector, type WakeWordEngine } from './wake-word.js';

/** The model file shipped inside the npm package, and its module. */
export const VOXRT_MODEL_FILE = 'voxrt_wake_word.vxrt';
export const VOXRT_WASM_FILE = 'voxrt-wake-word-browser_bg.wasm';
export const VOXRT_PACKAGE = '@voxrt/wake-word-browser';
export const VOXRT_PHRASE = 'hey assistant';

interface VoxrtDetection {
  readonly score: number;
}

interface VoxrtEngine {
  readonly threshold: number;
  readonly cooldownFrames: number;
  pushPcmF32(pcm: Float32Array): VoxrtDetection[];
  reset(): void;
  free(): void;
}

interface VoxrtModule {
  default(input: { module_or_path: Uint8Array }): Promise<unknown>;
  WakeWordEngine: { fromBytes(bytes: Uint8Array): VoxrtEngine };
  version(): string;
}

const require_ = createRequire(import.meta.url);

/**
 * The installed package directory. Only the wasm is a declared export; the
 * `.vxrt` model sits beside it and is addressed by path, which is why the
 * package directory is derived from the wasm's resolved location.
 */
function voxrtPackageDir(): string {
  return dirname(require_.resolve(`${VOXRT_PACKAGE}/${VOXRT_WASM_FILE}`));
}

/** Absolute path to a file inside the installed VoxRT package. */
export function voxrtAssetPath(file: string): string {
  return join(voxrtPackageDir(), file);
}

/**
 * The VoxRT engine adapted to the runtime's {@link WakeWordEngine} seam. Model
 * loading happens in `init()`; frames pass straight through; a processing throw
 * is contained so a detector fault can never take down the audio callback.
 */
export class VoxrtWakeWordEngine implements WakeWordEngine {
  readonly engineId = VOXRT_PACKAGE;
  readonly modelId = `${VOXRT_MODEL_FILE}:${VOXRT_PHRASE}`;
  private readonly modelPath: string;
  private engine: VoxrtEngine | undefined;
  private sdkVersion = 'unknown';

  constructor(modelPath: string = voxrtAssetPath(VOXRT_MODEL_FILE)) {
    this.modelPath = modelPath;
  }

  async init(): Promise<void> {
    let module: VoxrtModule;
    try {
      module = (await import(VOXRT_PACKAGE)) as VoxrtModule;
    } catch (error) {
      throw new VoiceError(
        'device_unavailable',
        `The wake-word engine "${VOXRT_PACKAGE}" is not installed.`,
        error,
      );
    }
    let wasmBytes: Uint8Array;
    let modelBytes: Uint8Array;
    try {
      wasmBytes = new Uint8Array(readFileSync(voxrtAssetPath(VOXRT_WASM_FILE)));
      modelBytes = new Uint8Array(readFileSync(this.modelPath));
    } catch (error) {
      throw new VoiceError(
        'device_unavailable',
        `The wake-word model "${VOXRT_MODEL_FILE}" is missing.`,
        error,
      );
    }
    await module.default({ module_or_path: wasmBytes });
    this.sdkVersion = module.version();
    this.engine = module.WakeWordEngine.fromBytes(modelBytes);
  }

  process(frame: Float64Array): WakeWordDetection | undefined {
    const engine = this.engine;
    if (engine === undefined) return undefined;
    const pcm = Float32Array.from(frame);
    const detections = engine.pushPcmF32(pcm);
    const last = detections[detections.length - 1];
    if (last === undefined) return undefined;
    return { phrase: VOXRT_PHRASE, confidence: last.score };
  }

  async release(): Promise<void> {
    this.engine?.free();
    this.engine = undefined;
  }

  /** A precise, user-safe engine identifier, for diagnostics. */
  describe(): string {
    return `${VOXRT_PACKAGE}@${this.sdkVersion}`;
  }
}

/**
 * Build the runtime-facing detector backed by VoxRT. `init()` fails observably
 * (never silently) when the package or its model is absent.
 */
export function createVoxrtDetector(modelPath?: string): WakeWordDetector {
  const engine = modelPath === undefined ? new VoxrtWakeWordEngine() : new VoxrtWakeWordEngine(modelPath);
  return new EngineWakeWordDetector(engine);
}
