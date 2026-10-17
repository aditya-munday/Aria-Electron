import { describe, expect, it } from 'vitest';

import {
  SidecarSupervisor,
  type SidecarChild,
  type SidecarSpawn,
} from './sidecar-supervisor.js';
import { SIDECAR_PROTOCOL_VERSION, encodeJsonFrame } from './sidecar-protocol.js';

type Listener = (...args: never[]) => void;

class FakeChild implements SidecarChild {
  private readonly dataListeners: ((chunk: Buffer) => void)[] = [];
  private readonly closeListeners: ((code: number | null) => void)[] = [];
  private readonly errorListeners: ((error: Error) => void)[] = [];
  readonly stdinData: Buffer[] = [];
  ended = false;
  killed = false;
  readonly stdin = {
    write: (data: Uint8Array): void => {
      this.stdinData.push(Buffer.from(data));
    },
    end: (data?: Uint8Array): void => {
      if (data !== undefined) this.stdinData.push(Buffer.from(data));
      this.ended = true;
    },
    on: (_event: 'error', _listener: (error: Error) => void): void => undefined,
  };
  readonly stdout = {
    on: (event: 'data', listener: (chunk: Buffer) => void): void => {
      if (event === 'data') this.dataListeners.push(listener);
    },
  };
  readonly stderr = {
    on: (_event: 'data', _listener: (chunk: Buffer) => void): void => undefined,
  };

  on(event: 'error' | 'close', listener: Listener): void {
    if (event === 'error') this.errorListeners.push(listener as (error: Error) => void);
    else this.closeListeners.push(listener as (code: number | null) => void);
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  emit(frame: unknown): void {
    const bytes = encodeJsonFrame(frame);
    for (const listener of this.dataListeners) listener(bytes);
  }

  close(code: number | null): void {
    for (const listener of this.closeListeners) listener(code);
  }

  fail(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }
}

function spawnReturning(...children: FakeChild[]): { spawn: SidecarSpawn; spawned: FakeChild[] } {
  const spawned: FakeChild[] = [];
  const spawn: SidecarSpawn = () => {
    const child = children[spawned.length] ?? new FakeChild();
    spawned.push(child);
    return child;
  };
  return { spawn, spawned };
}

function noSleep(): Promise<void> {
  return Promise.resolve();
}

describe('SidecarSupervisor', () => {
  it('resolves start once a matching ready event arrives', async () => {
    const child = new FakeChild();
    const { spawn } = spawnReturning(child);
    const supervisor = new SidecarSupervisor({ command: 'aria-voice', spawn, sleep: noSleep });
    const started = supervisor.start();
    child.emit({ event: 'ready', protocol_version: SIDECAR_PROTOCOL_VERSION });
    await started;
    expect(supervisor.status()).toBe('ready');
  });

  it('fails start on a protocol version mismatch', async () => {
    const child = new FakeChild();
    const { spawn } = spawnReturning(child);
    const supervisor = new SidecarSupervisor({ command: 'aria-voice', spawn, sleep: noSleep });
    const started = supervisor.start();
    child.emit({ event: 'ready', protocol_version: SIDECAR_PROTOCOL_VERSION + 1 });
    await expect(started).rejects.toThrow(/does not match/);
    expect(supervisor.status()).toBe('failed');
  });

  it('fails start when the child exits before ready', async () => {
    const child = new FakeChild();
    const { spawn } = spawnReturning(child);
    const supervisor = new SidecarSupervisor({ command: 'aria-voice', spawn, sleep: noSleep });
    const started = supervisor.start();
    child.close(1);
    await expect(started).rejects.toThrow(/exited/);
    expect(supervisor.status()).toBe('failed');
  });

  it('fails start when the process cannot be spawned', async () => {
    const spawn: SidecarSpawn = () => {
      throw new Error('ENOENT');
    };
    const supervisor = new SidecarSupervisor({ command: 'missing', spawn, sleep: noSleep });
    await expect(supervisor.start()).rejects.toThrow('ENOENT');
    expect(supervisor.status()).toBe('failed');
    expect(supervisor.failure()).toBe('ENOENT');
  });

  it('restarts after a crash and becomes ready again', async () => {
    const first = new FakeChild();
    const second = new FakeChild();
    const { spawn, spawned } = spawnReturning(first, second);
    const statuses: string[] = [];
    const supervisor = new SidecarSupervisor({
      command: 'aria-voice',
      spawn,
      sleep: noSleep,
      onStatus: (status) => statuses.push(status),
    });
    const started = supervisor.start();
    first.emit({ event: 'ready', protocol_version: SIDECAR_PROTOCOL_VERSION });
    await started;

    first.close(1);
    // The restart is scheduled on a microtask chain; yield until respawned.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(spawned).toHaveLength(2);
    expect(statuses).toContain('restarting');
    second.emit({ event: 'ready', protocol_version: SIDECAR_PROTOCOL_VERSION });
    expect(supervisor.status()).toBe('ready');
  });

  it('gives up after the restart budget is exhausted', async () => {
    const first = new FakeChild();
    const { spawn, spawned } = spawnReturning(first);
    const supervisor = new SidecarSupervisor({
      command: 'aria-voice',
      spawn,
      sleep: noSleep,
      maxRestarts: 2,
    });
    const started = supervisor.start();
    first.emit({ event: 'ready', protocol_version: SIDECAR_PROTOCOL_VERSION });
    await started;

    // Every respawned child crashes immediately.
    first.close(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const child of spawned.slice(1)) child.close(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const child of spawned.slice(1)) child.close(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(supervisor.status()).toBe('failed');
    expect(supervisor.failure()).toMatch(/giving up/);
  });

  it('frames commands and refuses to write when not ready', () => {
    const child = new FakeChild();
    const { spawn } = spawnReturning(child);
    const supervisor = new SidecarSupervisor({ command: 'aria-voice', spawn, sleep: noSleep });
    expect(supervisor.send({ type: 'ping' })).toBe(false);
  });

  it('sends a shutdown command and stops', async () => {
    const child = new FakeChild();
    const { spawn } = spawnReturning(child);
    const supervisor = new SidecarSupervisor({ command: 'aria-voice', spawn, sleep: noSleep });
    const started = supervisor.start();
    child.emit({ event: 'ready', protocol_version: SIDECAR_PROTOCOL_VERSION });
    await started;

    await supervisor.stop();
    expect(supervisor.status()).toBe('stopped');
    expect(child.killed).toBe(true);
    const sent = Buffer.concat(child.stdinData).toString('utf8');
    expect(sent).toContain('shutdown');
  });

  it('delivers validated events to the callback and drops malformed ones', async () => {
    const child = new FakeChild();
    const { spawn } = spawnReturning(child);
    const events: string[] = [];
    const supervisor = new SidecarSupervisor({
      command: 'aria-voice',
      spawn,
      sleep: noSleep,
      onEvent: (event) => events.push(event.event),
    });
    const started = supervisor.start();
    child.emit({ event: 'ready', protocol_version: SIDECAR_PROTOCOL_VERSION });
    await started;
    child.emit({ event: 'wake', model: 'alexa_v0.1', score: 0.9 });
    child.emit({ event: 'nonsense' });
    expect(events).toEqual(['ready', 'wake']);
  });
});
