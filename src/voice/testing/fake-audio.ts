/**
 * Deterministic audio test fixtures.
 *
 * These are *test doubles for hardware*, explicitly identified as such: a
 * {@link FakeMicrophone} drives the runtime with frames a test controls, so
 * device changes, permission denial and frame timing are exercised without real
 * hardware. They are real implementations of the runtime's interfaces, not
 * mocks of the code under test: the runtime runs its real pipeline against them.
 *
 * The sample generators produce ordinary signals (silence, a sine tone, white
 * noise) so VAD and noise-reduction behaviour is exercised on realistic input.
 */

import type {
  AudioDevice,
  CaptureHandle,
  DeviceChangeEvent,
  Microphone,
  MicrophonePermission,
} from '../device.js';
import { VoiceError } from '../errors.js';

export function silence(samples: number): Float64Array {
  return new Float64Array(samples);
}

export function tone(samples: number, amplitude = 0.5, hz = 440, sampleRate = 16_000): Float64Array {
  const out = new Float64Array(samples);
  for (let i = 0; i < samples; i += 1) {
    out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  }
  return out;
}

export function noise(samples: number, amplitude = 0.01, seed = 1): Float64Array {
  const out = new Float64Array(samples);
  let state = seed;
  for (let i = 0; i < samples; i += 1) {
    // A small, deterministic LCG; no real randomness in a test fixture.
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    out[i] = ((state / 0x7fffffff) * 2 - 1) * amplitude;
  }
  return out;
}

export class FakeCaptureHandle implements CaptureHandle {
  readonly deviceId: string;
  readonly format: { sampleRate: number; channels: number };
  private frameHandler: ((frame: Float64Array) => void) | undefined;
  private lostHandler: ((error: VoiceError) => void) | undefined;
  private started = false;

  constructor(deviceId: string, format: { sampleRate: number; channels: number }) {
    this.deviceId = deviceId;
    this.format = format;
  }

  onFrame(handler: (frame: Float64Array) => void): void {
    this.frameHandler = handler;
  }

  onLost(handler: (error: VoiceError) => void): void {
    this.lostHandler = handler;
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  get isStarted(): boolean {
    return this.started;
  }

  /** Deliver a frame as if captured from the device. */
  emit(frame: Float64Array): void {
    if (!this.started) return;
    this.frameHandler?.(frame);
  }

  /** Simulate the device disappearing. */
  lose(message = 'The audio device was disconnected.'): void {
    this.started = false;
    this.lostHandler?.(new VoiceError('device_unavailable', message));
  }
}

export interface FakeMicrophoneOptions {
  readonly permission?: MicrophonePermission;
  readonly devices?: readonly AudioDevice[];
  /** Fail `open()` with this error (device unavailable). */
  readonly failOpen?: VoiceError;
  /** Whether a long-lived capture stream can be opened (default true). */
  readonly captureCapable?: boolean;
}

export class FakeMicrophone implements Microphone {
  private permissionState: MicrophonePermission;
  private devices: readonly AudioDevice[];
  private readonly failOpen: VoiceError | undefined;
  private readonly captureCapable: boolean;
  private readonly changeHandlers = new Set<(event: DeviceChangeEvent) => void>();
  readonly handles: FakeCaptureHandle[] = [];
  openCount = 0;

  constructor(options: FakeMicrophoneOptions = {}) {
    this.permissionState = options.permission ?? 'granted';
    this.devices =
      options.devices ?? [{ id: 'default', label: 'Default Microphone', isDefault: true }];
    this.failOpen = options.failOpen;
    this.captureCapable = options.captureCapable ?? true;
  }

  async permission(): Promise<MicrophonePermission> {
    return this.permissionState;
  }

  async requestPermission(): Promise<MicrophonePermission> {
    return this.permissionState;
  }

  setPermission(state: MicrophonePermission): void {
    this.permissionState = state;
  }

  async listDevices(): Promise<readonly AudioDevice[]> {
    return this.devices;
  }

  async captureCapableDevices(): Promise<readonly AudioDevice[]> {
    return this.captureCapable ? this.devices : [];
  }

  onDeviceChange(handler: (event: DeviceChangeEvent) => void): () => void {
    this.changeHandlers.add(handler);
    return () => this.changeHandlers.delete(handler);
  }

  emitDeviceChange(event: DeviceChangeEvent): void {
    this.devices = event.devices;
    for (const handler of this.changeHandlers) handler(event);
  }

  async open(options: {
    deviceId?: string;
    format: { sampleRate: number; channels: number };
  }): Promise<CaptureHandle> {
    this.openCount += 1;
    if (this.failOpen !== undefined) throw this.failOpen;
    const handle = new FakeCaptureHandle(options.deviceId ?? 'default', options.format);
    this.handles.push(handle);
    return handle;
  }

  /** The most recently opened handle. */
  lastHandle(): FakeCaptureHandle | undefined {
    return this.handles[this.handles.length - 1];
  }
}
