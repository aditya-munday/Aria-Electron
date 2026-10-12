/**
 * The wake-word listener: a background capture stream that feeds the local
 * detector while no voice session is active.
 *
 * It is deliberately independent of a voice session. Wake-word detection runs
 * locally, requires no Backend connection, and never submits audio anywhere: the
 * frames it captures go only to the detector. When a valid detection arrives the
 * listener stops its capture and hands control to the runtime, which opens a
 * session capture of its own.
 *
 * A device loss or permission problem puts the listener into a recoverable
 * `failed` state rather than leaving a dead capture running.
 */

import { assertAudioFormat } from './audio-format.js';
import type { CaptureHandle, Microphone } from './device.js';
import { asVoiceError, VoiceError } from './errors.js';
import {
  createEchoCanceller,
  DEFAULT_ECHO_CANCELLATION,
  FarEndReference,
  type EchoCanceller,
} from './echo-cancellation.js';
import type { WakeWordActivation, WakeWordController } from './wake-word.js';

export type WakeListenerState = 'stopped' | 'starting' | 'listening' | 'failed';

export interface WakeWordListenerDeps {
  readonly microphone: Microphone;
  readonly controller: WakeWordController;
  readonly sampleRate: number;
  readonly frameMs: number;
  readonly now: () => number;
  readonly onActivation: (activation: WakeWordActivation) => void;
  readonly onError?: (error: VoiceError) => void;
  readonly deviceId?: string;
  /**
   * The far-end reference of Aria's own playback, when echo cancellation is on.
   * It is pushed into the detector alongside each frame so Aria's spoken reply
   * does not re-trigger the wake word.
   */
  readonly farEnd?: FarEndReference;
}

export class WakeWordListener {
  private readonly deps: WakeWordListenerDeps;
  private handle: CaptureHandle | undefined;
  private canceller: EchoCanceller | undefined;
  private state: WakeListenerState = 'stopped';
  private lastError: VoiceError | undefined;

  constructor(deps: WakeWordListenerDeps) {
    this.deps = deps;
  }

  status(): WakeListenerState {
    return this.state;
  }

  failure(): VoiceError | undefined {
    return this.lastError;
  }

  isListening(): boolean {
    return this.state === 'listening';
  }

  /** Start listening. Requires microphone permission; fails observably otherwise. */
  async start(): Promise<void> {
    if (this.state === 'listening' || this.state === 'starting') return;
    this.state = 'starting';
    try {
      const permission = await this.deps.microphone.permission();
      if (permission !== 'granted') {
        throw new VoiceError('permission_denied', 'Microphone access is not granted.');
      }
      assertAudioFormat({ sampleRate: this.deps.sampleRate, channels: 1 }, 'wake-word format');
      const handle = await this.deps.microphone.open({
        ...(this.deps.deviceId !== undefined ? { deviceId: this.deps.deviceId } : {}),
        format: { sampleRate: this.deps.sampleRate, channels: 1 },
      });
      this.handle = handle;
      handle.onLost((error) => this.onLost(error));
      handle.onFrame((frame) => this.onFrame(frame));
      await handle.start();
      this.state = 'listening';
    } catch (error) {
      const voiceError = asVoiceError(error, 'capture_failed');
      this.lastError = voiceError;
      this.state = 'failed';
      this.deps.onError?.(voiceError);
    }
  }

  /** Stop listening and release the capture. Idempotent. */
  async stop(): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    if (handle !== undefined) await handle.stop().catch(() => undefined);
    if (this.state !== 'failed') this.state = 'stopped';
  }

  /** Reset a failed listener so it can be started again (recovery). */
  reset(): void {
    if (this.state === 'failed') {
      this.state = 'stopped';
      this.lastError = undefined;
    }
  }

  private onFrame(frame: Float64Array): void {
    if (this.state !== 'listening') return;
    let signal = frame;
    const farEnd = this.deps.farEnd;
    if (farEnd !== undefined) {
      this.canceller ??= createEchoCanceller(DEFAULT_ECHO_CANCELLATION, this.deps.sampleRate);
      this.canceller.setFarEnd(farEnd.drain(frame.length));
      signal = this.canceller.process(frame);
    }
    const activation = this.deps.controller.push(signal, this.deps.now());
    if (activation === undefined) return;
    // A detection: stop listening so the session owns the microphone.
    this.state = 'stopped';
    this.deps.onActivation(activation);
  }

  private onLost(error: VoiceError): void {
    this.handle = undefined;
    this.lastError = error;
    this.state = 'failed';
    this.deps.onError?.(error);
  }
}
