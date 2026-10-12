/**
 * Audio-device management.
 *
 * Aria never touches an audio API directly; it depends on a {@link Microphone}
 * abstraction. The production implementation wraps a native capture API, and a
 * deterministic fixture drives tests. Keeping devices behind an interface means
 * the runtime's device-change and recovery behaviour is testable without real
 * hardware.
 *
 * A device list can change at any time (a USB headset is unplugged, Bluetooth
 * reconnects). A capture session is bound to the device it was opened on and
 * must fail observably — never silently switch device mid-utterance — when that
 * device disappears.
 */

import type { AudioFormat } from './audio-format.js';
import { VoiceError } from './errors.js';

export type MicrophonePermission = 'granted' | 'denied' | 'prompt';

export interface AudioDevice {
  readonly id: string;
  readonly label: string;
  /** Whether this is the system default capture device. */
  readonly isDefault: boolean;
}

export interface DeviceChangeEvent {
  readonly devices: readonly AudioDevice[];
  /** The id of the device that disappeared, when this is a removal. */
  readonly removed?: string;
  /** The id of the device that appeared, when this is an addition. */
  readonly added?: string;
}

/** A live capture handle for one device. */
export interface CaptureHandle {
  readonly deviceId: string;
  readonly format: AudioFormat;
  /** Invoked for each captured frame. Must never throw into the audio thread. */
  onFrame(handler: (frame: Float64Array) => void): void;
  /** Invoked when the device is lost. */
  onLost(handler: (error: VoiceError) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface Microphone {
  /** The current permission state; Aria asks before it opens a device. */
  permission(): Promise<MicrophonePermission>;
  /** Request permission (may prompt). Returns the resulting state. */
  requestPermission(): Promise<MicrophonePermission>;
  listDevices(): Promise<readonly AudioDevice[]>;
  /** Subscribe to device add/remove events. Returns an unsubscribe function. */
  onDeviceChange(handler: (event: DeviceChangeEvent) => void): () => void;
  /** Open a capture handle on a device (or the default when `deviceId` is omitted). */
  open(options: { deviceId?: string; format: AudioFormat }): Promise<CaptureHandle>;
  /**
   * The devices Aria can actually open a capture on, when that differs from
   * {@link listDevices}. A microphone backend that can play a whole buffer but
   * not stream reports `[]` here, so the runtime keeps push-to-talk (buffer
   * capture) while the streaming wake-word listener honestly stands down.
   */
  captureCapableDevices?(): Promise<readonly AudioDevice[]>;
}
