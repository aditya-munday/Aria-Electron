/**
 * The supervisor for the Python voice sidecar process.
 *
 * The sidecar is spawned as a child so a native or model fault in it (the exact
 * failure that took down 0.7.6) can crash that process but never the Electron
 * main process. The supervisor owns the process lifecycle — health handshake,
 * restart with bounded exponential backoff, clean shutdown on quit — and turns
 * its stdout into validated events.
 *
 * Truth rule: the supervisor reports what is actually true. A crash is a
 * `failed` status with a reason, never a silent `ready`; a restart is a
 * `restarting` status the UI can show. It never invents a working microphone.
 */

import { spawn } from 'node:child_process';

import {
  SIDECAR_PROTOCOL_VERSION,
  SidecarFrameReader,
  encodeJsonFrame,
  parseSidecarEvent,
  type SidecarCommand,
  type SidecarEvent,
} from './sidecar-protocol.js';

export type SidecarStatus = 'stopped' | 'starting' | 'ready' | 'restarting' | 'failed';

export interface WritableLike {
  write(data: Uint8Array): unknown;
  end(data?: Uint8Array): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface ReadableLike {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
}

/** The minimal slice of a spawned child the supervisor drives, so tests can fake it. */
export interface SidecarChild {
  readonly stdin: WritableLike | null;
  readonly stdout: ReadableLike | null;
  readonly stderr: ReadableLike | null;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SidecarSpawn = (
  command: string,
  args: readonly string[],
  options?: { readonly stdio?: readonly (string | number)[]; readonly env?: NodeJS.ProcessEnv },
) => SidecarChild;

export const defaultSidecarSpawn: SidecarSpawn = (command, args, options) =>
  spawn(command, [...args], {
    stdio: (options?.stdio ?? ['pipe', 'pipe', 'pipe']) as never,
    ...(options?.env !== undefined ? { env: options.env } : {}),
  }) as unknown as SidecarChild;

export interface SidecarSupervisorOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly spawn?: SidecarSpawn;
  readonly env?: NodeJS.ProcessEnv;
  /** How many times a crash restarts before the supervisor gives up. */
  readonly maxRestarts?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** How long to wait for the `ready` event before treating the start as failed. */
  readonly readyTimeoutMs?: number;
  readonly onEvent?: (event: SidecarEvent) => void;
  readonly onStatus?: (status: SidecarStatus, detail?: string) => void;
  /** Injected for deterministic tests; defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESTARTS = 5;
const DEFAULT_BASE_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 10_000;
const DEFAULT_READY_TIMEOUT_MS = 20_000;

/**
 * Owns one sidecar process and its restart policy.
 *
 * `start()` spawns the child and resolves once it reports `ready` with a
 * matching protocol version. A version mismatch, a timeout or an early exit is a
 * typed failure. `send()` frames a command; it is a no-op (returning `false`)
 * when the sidecar is not ready, so a caller can never write into a dead pipe.
 */
export class SidecarSupervisor {
  private readonly options: SidecarSupervisorOptions;
  private readonly maxRestarts: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly readyTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  private child: SidecarChild | undefined;
  private reader = new SidecarFrameReader();
  private state: SidecarStatus = 'stopped';
  private lastFailure: string | undefined;
  private restarts = 0;
  private stopping = false;
  private readyResolve: (() => void) | undefined;
  private readyReject: ((error: Error) => void) | undefined;
  private readyTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<(event: SidecarEvent) => void>();

  constructor(options: SidecarSupervisorOptions) {
    this.options = options;
    this.maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  status(): SidecarStatus {
    return this.state;
  }

  failure(): string | undefined {
    return this.lastFailure;
  }

  /**
   * Subscribe to validated events. Returns an unsubscribe function. Multiple
   * consumers (the wake detector, a diagnostics view) can observe one process.
   */
  onEvent(listener: (event: SidecarEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emitEvent(event: SidecarEvent): void {
    this.options.onEvent?.(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A misbehaving consumer must not break the supervisor.
      }
    }
  }

  /** Spawn the sidecar and resolve when it reports `ready`. */
  async start(): Promise<void> {
    this.stopping = false;
    this.restarts = 0;
    const ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.armReadyTimeout();
    // A spawn failure rejects `ready` through `failStart`; `spawnOnce` never
    // throws, so `ready` is the single rejection path.
    this.spawnOnce();
    await ready;
  }

  /** Frame and send a command. Returns false when the sidecar is not ready. */
  send(command: SidecarCommand): boolean {
    if (this.state !== 'ready' || this.child?.stdin == null) return false;
    try {
      this.child.stdin.write(encodeJsonFrame(command));
      return true;
    } catch {
      return false;
    }
  }

  /** Ask the sidecar to shut down, then stop the process. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.clearReadyTimer();
    const child = this.child;
    if (child !== undefined) {
      try {
        child.stdin?.write(encodeJsonFrame({ type: 'shutdown' }));
        child.stdin?.end();
      } catch {
        // The pipe may already be closed; killing below is what matters.
      }
      child.kill('SIGTERM');
    }
    this.child = undefined;
    this.setState('stopped');
  }

  private setState(status: SidecarStatus, detail?: string): void {
    this.state = status;
    if (detail !== undefined) this.lastFailure = detail;
    this.options.onStatus?.(status, detail);
  }

  private armReadyTimeout(): void {
    this.clearReadyTimer();
    this.readyTimer = setTimeout(() => {
      this.failStart(`the sidecar did not become ready within ${this.readyTimeoutMs}ms`);
    }, this.readyTimeoutMs);
    // Do not keep the event loop alive on the handshake timer alone.
    this.readyTimer.unref?.();
  }

  private clearReadyTimer(): void {
    if (this.readyTimer !== undefined) {
      clearTimeout(this.readyTimer);
      this.readyTimer = undefined;
    }
  }

  /** Spawn once. Returns false when the spawn itself threw. */
  private spawnOnce(): boolean {
    this.setState('starting');
    this.reader = new SidecarFrameReader();
    let child: SidecarChild;
    try {
      child = (this.options.spawn ?? defaultSidecarSpawn)(
        this.options.command,
        this.options.args ?? [],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          ...(this.options.env !== undefined ? { env: this.options.env } : {}),
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'the sidecar failed to spawn';
      // A spawn failure rejects the pending start (or, for a restart, is
      // reported through status) — it is never thrown, so there is one path.
      this.failStart(message);
      return false;
    }
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    child.stderr?.on('data', () => {
      // Structured logs only; never surfaced as events.
    });
    child.on('error', (error: Error) => this.onExit(undefined, error.message));
    child.on('close', (code: number | null) => this.onExit(code, undefined));
    return true;
  }

  private onData(chunk: Buffer): void {
    let frames;
    try {
      frames = this.reader.feed(chunk);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'bad sidecar frame';
      this.failStart(message);
      return;
    }
    for (const frame of frames) {
      const event = parseSidecarEvent(frame.payload);
      if (event === undefined) continue;
      if (event.event === 'ready') {
        if (event.protocol_version !== SIDECAR_PROTOCOL_VERSION) {
          this.failStart(
            `sidecar protocol ${event.protocol_version} does not match ${SIDECAR_PROTOCOL_VERSION}`,
          );
          continue;
        }
        this.clearReadyTimer();
        this.setState('ready');
        const resolve = this.readyResolve;
        this.readyResolve = undefined;
        this.readyReject = undefined;
        resolve?.();
      }
      this.emitEvent(event);
    }
  }

  private onExit(code: number | null | undefined, errorMessage?: string): void {
    this.child = undefined;
    if (this.stopping) {
      this.setState('stopped');
      return;
    }
    const reason =
      errorMessage ??
      (code === null || code === undefined ? 'the sidecar exited' : `the sidecar exited (code ${code})`);
    // A crash before `ready` rejects the pending start; a crash after it drives
    // the restart policy so a transient fault recovers without a relaunch.
    if (this.readyReject !== undefined) {
      this.failStart(reason);
      return;
    }
    void this.scheduleRestart(reason);
  }

  private failStart(message: string): void {
    this.clearReadyTimer();
    this.setState('failed', message);
    const reject = this.readyReject;
    this.readyResolve = undefined;
    this.readyReject = undefined;
    reject?.(new Error(message));
  }

  private async scheduleRestart(reason: string): Promise<void> {
    if (this.restarts >= this.maxRestarts) {
      this.setState('failed', `${reason}; giving up after ${this.restarts} restarts`);
      return;
    }
    this.restarts += 1;
    const backoff = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** (this.restarts - 1));
    this.setState('restarting', `${reason}; restart ${this.restarts} in ${backoff}ms`);
    await this.sleep(backoff);
    if (this.stopping) return;
    if (!this.spawnOnce()) {
      await this.scheduleRestart('respawn failed');
    }
  }
}
