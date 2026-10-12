import { spawn } from 'node:child_process';

import type { CaptureHandle } from './device.js';
import type { AudioFormat } from './audio-format.js';
import { VoiceError } from './errors.js';

/** The minimal slice of a spawned child process Aria drives, so tests can fake it. */
export interface WritableLike {
  write(data: Uint8Array): unknown;
  end(data?: Uint8Array): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface ReadableLike {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
}

export interface AudioChildProcess {
  readonly stdin: WritableLike | null;
  readonly stdout: ReadableLike | null;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type AudioSpawn = (
  command: string,
  args: readonly string[],
  options?: { readonly stdio?: readonly (string | number)[] },
) => AudioChildProcess;

export const defaultAudioSpawn: AudioSpawn = (command, args, options) =>
  spawn(command, [...args], {
    stdio: (options?.stdio ?? ['pipe', 'pipe', 'ignore']) as never,
  }) as unknown as AudioChildProcess;

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface StreamingCaptureOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly sampleRate: number;
  readonly channels: number;
  readonly frameMs: number;
  readonly deviceId?: string;
  readonly spawn?: AudioSpawn;
  readonly stdErr?: 'inherit' | 'ignore';
}

/**
 * A capture handle backed by a short-lived command-line recorder.
 *
 * The tool writes little-endian i16 PCM to its stdout; this reads that stream and
 * slices it into fixed-size frames. A process that dies is a lost device, not a
 * silent hang: the handle reports it through `onLost`.
 */
export class StreamingCapture implements CaptureHandle {
  readonly deviceId: string;
  readonly format: AudioFormat;
  private readonly options: StreamingCaptureOptions;
  private process: AudioChildProcess | undefined;
  private frameHandler: ((frame: Float64Array) => void) | undefined;
  private lostHandler: ((error: VoiceError) => void) | undefined;
  private pending: Buffer = Buffer.alloc(0);
  private stopped = false;
  private started = false;

  constructor(options: StreamingCaptureOptions) {
    this.options = options;
    this.deviceId = options.deviceId ?? 'default';
    this.format = { sampleRate: options.sampleRate, channels: options.channels };
  }

  onFrame(handler: (frame: Float64Array) => void): void {
    this.frameHandler = handler;
  }

  onLost(handler: (error: VoiceError) => void): void {
    this.lostHandler = handler;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const spawnProcess = this.options.spawn ?? defaultAudioSpawn;
    let process: AudioChildProcess;
    try {
      process = spawnProcess(this.options.command, [...this.options.args], {
        stdio: ['ignore', 'pipe', this.options.stdErr ?? 'ignore'],
      });
    } catch (error) {
      this.started = false;
      throw new VoiceError('capture_failed', describeError(error));
    }
    this.process = process;
    process.on('error', (error) => this.fail(new VoiceError('device_unavailable', error.message)));
    process.on('close', () => this.fail(new VoiceError('device_unavailable', 'The capture process ended.')));
    const stdout = process.stdout;
    if (stdout === null) {
      this.fail(new VoiceError('capture_failed', 'The capture process produced no audio stream.'));
      return;
    }
    stdout.on('data', (chunk) => this.consume(chunk));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    const process = this.process;
    this.process = undefined;
    if (process !== undefined) {
      try {
        process.kill('SIGTERM');
      } catch {
        // The process already exited; nothing to stop.
      }
    }
  }

  private consume(chunk: Buffer): void {
    if (this.stopped) return;
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const frameBytes = this.frameBytes();
    while (this.pending.length >= frameBytes) {
      const frame = toFrame(this.pending.subarray(0, frameBytes));
      this.pending = this.pending.subarray(frameBytes);
      this.frameHandler?.(frame);
    }
  }

  private frameBytes(): number {
    const samples = Math.max(1, Math.round((this.options.frameMs * this.options.sampleRate) / 1000));
    return samples * this.options.channels * 2;
  }

  private fail(error: VoiceError): void {
    if (this.stopped) return;
    this.stopped = true;
    this.started = false;
    this.lostHandler?.(error);
  }
}

function toFrame(bytes: Uint8Array): Float64Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = Math.floor(bytes.byteLength / 2);
  const frame = new Float64Array(samples);
  for (let i = 0; i < samples; i += 1) {
    frame[i] = view.getInt16(i * 2, true) / 32_768;
  }
  return frame;
}

export interface PcmPlayerOptions {
  readonly command: string;
  /** The player arguments for a given format; the Backend may vary sample rate. */
  readonly argsFor: (format: AudioFormat) => readonly string[];
  readonly spawn?: AudioSpawn;
  readonly stdErr?: 'inherit' | 'ignore';
}

function toPcmBytes(pcm: Int16Array): Buffer {
  const out = Buffer.allocUnsafe(pcm.length * 2);
  for (let i = 0; i < pcm.length; i += 1) out.writeInt16LE(pcm[i] ?? 0, i * 2);
  return out;
}

/**
 * A speaker backed by a command-line player that reads raw PCM from stdin.
 *
 * `stop()` kills the player immediately: an interruption must not wait for the
 * current buffer to drain. A player that exits early (a lost device) rejects the
 * play with `playback_failed` rather than resolving as if the audio were heard.
 */
export class PcmPlayback {
  private readonly options: PcmPlayerOptions;
  private process: AudioChildProcess | undefined;
  private current: { resolve: () => void; reject: (error: VoiceError) => void } | undefined;
  private stopped = false;

  constructor(options: PcmPlayerOptions) {
    this.options = options;
  }

  async play(pcm: Int16Array, format: AudioFormat): Promise<void> {
    if (this.process !== undefined || this.current !== undefined) await this.stop();
    this.stopped = false;
    const spawnProcess = this.options.spawn ?? defaultAudioSpawn;
    let process: AudioChildProcess;
    try {
      process = spawnProcess(this.options.command, [...this.options.argsFor(format)], {
        stdio: ['pipe', 'ignore', this.options.stdErr ?? 'ignore'],
      });
    } catch (error) {
      throw new VoiceError('playback_failed', describeError(error));
    }
    this.process = process;
    const stdin = process.stdin;
    if (stdin === null) {
      this.process = undefined;
      throw new VoiceError('playback_failed', 'The player produced no input stream.');
    }
    await new Promise<void>((resolve, reject) => {
      this.current = { resolve, reject };
      process.on('error', (error) => this.fail(new VoiceError('playback_failed', error.message)));
      process.on('close', (code) => {
        if (this.stopped) return;
        this.process = undefined;
        const current = this.current;
        this.current = undefined;
        if (current === undefined) return;
        if (code === 0 || code === null) current.resolve();
        else current.reject(new VoiceError('playback_failed', `The player exited with code ${code}.`));
      });
      stdin.on('error', (error) => this.fail(new VoiceError('playback_failed', error.message)));
      try {
        stdin.end(toPcmBytes(pcm));
      } catch (error) {
        this.fail(new VoiceError('playback_failed', describeError(error)));
      }
    });
  }

  /**
   * Play PCM chunks as they arrive through one long-lived player process, so the
   * response begins before synthesis ends. `stop()` kills the player promptly;
   * a player that dies early rejects with `playback_failed` rather than
   * resolving as if the audio were heard.
   */
  async playStream(
    chunks: AsyncIterable<Int16Array>,
    format: AudioFormat,
  ): Promise<void> {
    if (this.process !== undefined || this.current !== undefined) await this.stop();
    this.stopped = false;
    const spawnProcess = this.options.spawn ?? defaultAudioSpawn;
    let process: AudioChildProcess;
    try {
      process = spawnProcess(this.options.command, [...this.options.argsFor(format)], {
        stdio: ['pipe', 'ignore', this.options.stdErr ?? 'ignore'],
      });
    } catch (error) {
      throw new VoiceError('playback_failed', describeError(error));
    }
    this.process = process;
    const stdin = process.stdin;
    if (stdin === null) {
      this.process = undefined;
      throw new VoiceError('playback_failed', 'The player produced no input stream.');
    }
    await new Promise<void>((resolve, reject) => {
      this.current = { resolve, reject };
      process.on('error', (error) => this.fail(new VoiceError('playback_failed', error.message)));
      process.on('close', (code) => {
        if (this.stopped) return;
        this.process = undefined;
        const current = this.current;
        this.current = undefined;
        if (current === undefined) return;
        if (code === 0 || code === null) current.resolve();
        else current.reject(new VoiceError('playback_failed', `The player exited with code ${code}.`));
      });
      stdin.on('error', (error) => this.fail(new VoiceError('playback_failed', error.message)));
      void (async () => {
        try {
          for await (const chunk of chunks) {
            if (this.stopped) return;
            try {
              stdin.write(toPcmBytes(chunk));
            } catch (error) {
              this.fail(new VoiceError('playback_failed', describeError(error)));
              return;
            }
          }
          if (this.stopped) return;
          try {
            stdin.end();
          } catch {
            // The player already exited; the close handler reports it.
          }
        } catch (error) {
          this.fail(
            error instanceof VoiceError
              ? error
              : new VoiceError('playback_failed', describeError(error)),
          );
        }
      })();
    });
  }

  async stop(): Promise<void> {
    const process = this.process;
    this.process = undefined;
    const current = this.current;
    this.current = undefined;
    this.stopped = true;
    if (process !== undefined) {
      try {
        process.kill('SIGTERM');
      } catch {
        // The player already exited; the rejection below still fires.
      }
    }
    current?.reject(new VoiceError('cancelled', 'Playback was interrupted.'));
  }

  private fail(error: VoiceError): void {
    const current = this.current;
    this.current = undefined;
    this.process = undefined;
    current?.reject(error);
  }
}
