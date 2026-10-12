import { captureArgs, playbackArgs, probeAudioToolBackend, type AudioToolBackend } from './audio-tool.js';
import type { AudioFormat } from './audio-format.js';
import { PcmPlayback, StreamingCapture, type AudioSpawn } from './capture-tool.js';
import type {
  AudioDevice,
  CaptureHandle,
  DeviceChangeEvent,
  Microphone,
  MicrophonePermission,
} from './device.js';
import type { Speaker } from './playback.js';

export interface NativeAudioOptions {
  readonly backend: AudioToolBackend;
  readonly frameMs: number;
  readonly sampleRate: number;
  readonly spawn?: AudioSpawn;
}

/**
 * The command-line-tool microphone.
 *
 * Capture is a short-lived recorder spawned per utterance. Push-to-talk opens it
 * on the press and finalizes on the release; the streaming wake-word listener
 * opens a long-lived one. When the host has no recorder, `permission()` reports
 * `denied` and `captureCapableDevices()` is empty, so the runtime honestly
 * reports an inert voice engine instead of claiming a microphone it cannot open.
 */
export class NativeMicrophone implements Microphone {
  private readonly backend: AudioToolBackend;
  private readonly frameMs: number;
  private readonly spawn: AudioSpawn | undefined;

  constructor(options: NativeAudioOptions) {
    this.backend = options.backend;
    this.frameMs = options.frameMs;
    this.spawn = options.spawn;
  }

  async permission(): Promise<MicrophonePermission> {
    return this.backend.capture ? 'granted' : 'denied';
  }

  async requestPermission(): Promise<MicrophonePermission> {
    return this.permission();
  }

  async listDevices(): Promise<readonly AudioDevice[]> {
    if (!this.backend.capture) return [];
    return [{ id: 'default', label: 'System default microphone', isDefault: true }];
  }

  async captureCapableDevices(): Promise<readonly AudioDevice[]> {
    return this.listDevices();
  }

  onDeviceChange(_handler: (event: DeviceChangeEvent) => void): () => void {
    return () => undefined;
  }

  async open(options: {
    deviceId?: string;
    format: AudioFormat;
  }): Promise<CaptureHandle> {
    if (this.backend.captureCommand === undefined) {
      throw new Error('No capture device is available.');
    }
    const frameMs = this.frameMs;
    const command = this.backend.captureCommand;
    return new StreamingCapture({
      command,
      args: captureArgs(command, options.format, frameMs),
      sampleRate: options.format.sampleRate,
      channels: options.format.channels,
      frameMs,
      ...(options.deviceId !== undefined ? { deviceId: options.deviceId } : {}),
      ...(this.spawn !== undefined ? { spawn: this.spawn } : {}),
      stdErr: this.backend.captureStdErr,
    });
  }
}

/** The command-line-tool speaker; a no-op when the host has no player. */
export class NativeSpeaker implements Speaker {
  private readonly playback: PcmPlayback | undefined;
  private referenceTap: ((chunk: Int16Array) => void) | undefined;

  constructor(options: NativeAudioOptions) {
    const command = options.backend.playbackCommand;
    this.playback =
      command !== undefined
        ? new PcmPlayback({
            command,
            argsFor: (format) => playbackArgs(command, format),
            ...(options.spawn !== undefined ? { spawn: options.spawn } : {}),
            stdErr: options.backend.playbackStdErr,
          })
        : undefined;
  }

  setReferenceTap(tap: ((chunk: Int16Array) => void) | undefined): void {
    this.referenceTap = tap;
  }

  async play(pcm: Int16Array, format: AudioFormat): Promise<void> {
    if (this.playback === undefined) {
      // No player: the response is still produced, only its audio is absent.
      return;
    }
    this.referenceTap?.(pcm);
    await this.playback.play(pcm, format);
  }

  async playStream(
    chunks: AsyncIterable<Int16Array>,
    format: AudioFormat,
  ): Promise<void> {
    if (this.playback === undefined) {
      // No player: drain the stream so the producer does not stall, then return.
      for await (const _chunk of chunks) void _chunk;
      return;
    }
    const tap = this.referenceTap;
    const tapped =
      tap === undefined
        ? chunks
        : (async function* (): AsyncIterable<Int16Array> {
            for await (const chunk of chunks) {
              tap(chunk);
              yield chunk;
            }
          })();
    await this.playback.playStream(tapped, format);
  }

  async stop(): Promise<void> {
    await this.playback?.stop();
  }
}

/** Probe the host once and build the microphone/speaker pair for the runtime. */
export function createNativeAudio(options: {
  readonly frameMs: number;
  readonly sampleRate: number;
  readonly spawn?: AudioSpawn;
  readonly backend?: AudioToolBackend;
}): { readonly microphone: Microphone; readonly speaker: Speaker; readonly backend: AudioToolBackend } {
  const backend = options.backend ?? probeAudioToolBackend();
  const audio: NativeAudioOptions = {
    backend,
    frameMs: options.frameMs,
    sampleRate: options.sampleRate,
    ...(options.spawn !== undefined ? { spawn: options.spawn } : {}),
  };
  return { microphone: new NativeMicrophone(audio), speaker: new NativeSpeaker(audio), backend };
}
