/**
 * The microphone the renderer owns.
 *
 * The main process cannot reach a desktop microphone without an external
 * recorder (`parec`, `arecord`, `pw-record`), which a stock install may not
 * have — and the shipped `.deb` depends on none of them. A hidden renderer can:
 * `getUserMedia` needs no external tool and works on any Electron host. This
 * adapter drives that renderer over IPC — `start`/`stop` commands out, PCM
 * frames and status back — and presents it to the runtime as an ordinary
 * {@link Microphone}, so the wake-word listener and every voice session read
 * from it exactly as they would from a native device.
 *
 * The renderer is a dumb source: it captures 16 kHz mono PCM and nothing else.
 * Detection, the confidence floor and the cooldown stay in the main process, so
 * the wake word keeps working from the exact engine the runtime already tests.
 */

import { assertAudioFormat, type AudioFormat } from './audio-format.js';
import type {
  AudioDevice,
  CaptureHandle,
  DeviceChangeEvent,
  Microphone,
  MicrophonePermission,
} from './device.js';
import { VoiceError } from './errors.js';

/** The capture state the renderer reports back. */
export interface RendererCaptureStatus {
  readonly state: 'idle' | 'starting' | 'running' | 'error';
  readonly detail?: string;
}

/**
 * The transport to the hidden renderer. The concrete implementation lives in the
 * shell (it owns IPC); this is the seam the microphone depends on, so the
 * microphone is testable against a fake.
 */
export interface RendererCaptureTransport {
  /** Ask the renderer to begin capturing mono PCM at the given rate. */
  start(input: { readonly sampleRate: number; readonly frameMs: number }): void;
  /** Ask it to stop. Idempotent. */
  stop(): void;
  /** Subscribe to captured PCM chunks (16 kHz mono, signed 16-bit). */
  onFrame(handler: (chunk: Int16Array) => void): () => void;
  /** Subscribe to capture status. Returns an unsubscribe function. */
  onStatus(handler: (status: RendererCaptureStatus) => void): () => void;
}

const DEFAULT_DEVICE: AudioDevice = {
  id: 'renderer-default',
  label: 'System default microphone',
  isDefault: true,
};

export interface RendererMicrophoneDeps {
  readonly transport: RendererCaptureTransport;
  readonly sampleRate: number;
  readonly frameMs: number;
  /** How long to wait for the renderer to confirm capture, in ms. */
  readonly readyTimeoutMs?: number;
}

/**
 * Slice a 16 kHz mono `Int16Array` into fixed frames measured in samples, the
 * same way the native capture slices its PCM. A frame is
 * `round(frameMs * sampleRate / 1000)` samples, so a 20 ms frame at 16 kHz is
 * exactly 320 samples — the size the VAD and detector assume.
 */
class FrameSlicer {
  private pending: Int16Array = new Int16Array(0);

  constructor(private readonly frameSamples: number) {}

  push(chunk: Int16Array): Float64Array[] {
    const merged = new Int16Array(this.pending.length + chunk.length);
    merged.set(this.pending, 0);
    merged.set(chunk, this.pending.length);
    const frames: Float64Array[] = [];
    let offset = 0;
    while (merged.length - offset >= this.frameSamples) {
      const frame = new Float64Array(this.frameSamples);
      for (let i = 0; i < this.frameSamples; i += 1) {
        frame[i] = (merged[offset + i] as number) / 32_768;
      }
      frames.push(frame);
      offset += this.frameSamples;
    }
    this.pending = merged.subarray(offset);
    return frames;
  }

  reset(): void {
    this.pending = new Int16Array(0);
  }
}

export class RendererMicrophone implements Microphone, CaptureHandle {
  private readonly transport: RendererCaptureTransport;
  private readonly slicer: FrameSlicer;
  private readonly readyTimeoutMs: number;

  private status: RendererCaptureStatus = { state: 'idle' };
  private frameHandler: ((frame: Float64Array) => void) | undefined;
  private lostHandler: ((error: VoiceError) => void) | undefined;
  private ready:
    | { resolve: () => void; reject: (error: VoiceError) => void; timer: ReturnType<typeof setTimeout> }
    | undefined;
  /** Whether a consumer currently wants the microphone open. */
  private wantCapture = false;
  private startOptions: { readonly sampleRate: number; readonly frameMs: number };

  private captureFormat: AudioFormat;
  private captureDeviceId = DEFAULT_DEVICE.id;

  constructor(deps: RendererMicrophoneDeps) {
    this.transport = deps.transport;
    this.slicer = new FrameSlicer(
      Math.max(1, Math.round((deps.frameMs / 1000) * deps.sampleRate)),
    );
    this.readyTimeoutMs = deps.readyTimeoutMs ?? 8_000;
    this.captureFormat = { sampleRate: deps.sampleRate, channels: 1 };
    this.startOptions = { sampleRate: deps.sampleRate, frameMs: deps.frameMs };
    this.transport.onStatus((status) => this.onStatus(status));
    this.transport.onFrame((frame) => this.pushPcm(frame));
  }

  /** Feed a captured PCM chunk (already 16 kHz mono). Called from IPC. */
  pushPcm(chunk: Int16Array): void {
    if (this.status.state !== 'running') return;
    for (const frame of this.slicer.push(chunk)) this.frameHandler?.(frame);
  }

  get deviceId(): string {
    return this.captureDeviceId;
  }

  get format(): AudioFormat {
    return this.captureFormat;
  }

  /**
   * The renderer owns the real permission prompt; the app-level `media`
   * permission is already granted to its own frames. This reports granted
   * unconditionally: a capture error is transient (the device was busy, or the
   * OS prompt was dismissed) and must not be latched into a permanent denial.
   * Latching it here aborts every later capture before it can retry — the
   * wake-word session and push-to-talk alike — so a single renderer error would
   * disable the microphone for the rest of the run. A genuinely unavailable
   * device is reported by the capture attempt itself, not by this probe.
   */
  async permission(): Promise<MicrophonePermission> {
    return 'granted';
  }

  async requestPermission(): Promise<MicrophonePermission> {
    return this.permission();
  }

  async listDevices(): Promise<readonly AudioDevice[]> {
    return [DEFAULT_DEVICE];
  }

  async captureCapableDevices(): Promise<readonly AudioDevice[]> {
    return this.listDevices();
  }

  onDeviceChange(_handler: (event: DeviceChangeEvent) => void): () => void {
    return () => undefined;
  }

  async open(options: { deviceId?: string; format: AudioFormat }): Promise<CaptureHandle> {
    assertAudioFormat(options.format, 'renderer capture format');
    this.captureFormat = options.format;
    this.captureDeviceId = options.deviceId ?? DEFAULT_DEVICE.id;
    return this;
  }

  onFrame(handler: (frame: Float64Array) => void): void {
    this.frameHandler = handler;
  }

  onLost(handler: (error: VoiceError) => void): void {
    this.lostHandler = handler;
  }

  async start(): Promise<void> {
    this.wantCapture = true;
    this.startOptions = {
      sampleRate: this.captureFormat.sampleRate,
      frameMs: this.startOptions.frameMs,
    };
    // Always (re)assert the command: a stop may be in flight from the wake
    // listener handing the microphone to a session, and the renderer must be
    // told to start again after it stops.
    this.transport.start(this.startOptions);
    if (this.status.state === 'running') return;
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ready = undefined;
        reject(new VoiceError('capture_failed', 'The microphone did not start in time.'));
      }, this.readyTimeoutMs);
      this.ready = { resolve, reject, timer };
    });
    await ready;
  }

  async stop(): Promise<void> {
    this.wantCapture = false;
    this.transport.stop();
    // Discard any partial frame so it cannot bleed into the next capture.
    this.slicer.reset();
    // A start still waiting for the renderer to confirm is now moot; fail it
    // fast instead of leaving it to hit the timeout.
    const ready = this.ready;
    if (ready !== undefined) {
      clearTimeout(ready.timer);
      this.ready = undefined;
      ready.reject(new VoiceError('capture_failed', 'Capture was stopped before it started.'));
    }
  }

  private onStatus(status: RendererCaptureStatus): void {
    this.status = status;
    // The renderer confirms it has loaded and is ready to capture by reporting
    // `idle` (and `idle` again on a clean stop). A start command sent before the
    // renderer subscribed would otherwise be lost, so a requested capture is
    // (re)sent whenever the renderer reports it is idle.
    if (status.state === 'idle' && this.wantCapture) {
      this.transport.start(this.startOptions);
    }
    const ready = this.ready;
    if (status.state === 'running') {
      if (ready !== undefined) {
        clearTimeout(ready.timer);
        this.ready = undefined;
        ready.resolve();
      }
      return;
    }
    if (status.state === 'error') {
      const error = new VoiceError(
        'device_unavailable',
        status.detail ?? 'The microphone is unavailable.',
      );
      if (ready !== undefined) {
        clearTimeout(ready.timer);
        this.ready = undefined;
        ready.reject(error);
      }
      this.lostHandler?.(error);
    }
  }
}
