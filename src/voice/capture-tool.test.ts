import { describe, expect, it } from 'vitest';

import { PcmPlayback, StreamingCapture, type AudioChildProcess, type AudioSpawn } from './capture-tool.js';
import type { VoiceError } from './errors.js';

type Listener = (...args: never[]) => void;

class FakeChild implements AudioChildProcess {
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

  on(event: 'error' | 'close', listener: Listener): void {
    if (event === 'error') this.errorListeners.push(listener as (error: Error) => void);
    else this.closeListeners.push(listener as (code: number | null) => void);
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  emitData(chunk: Buffer): void {
    for (const listener of this.dataListeners) listener(chunk);
  }

  close(code: number | null): void {
    for (const listener of this.closeListeners) listener(code);
  }

  fail(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }
}

function pcm16(values: readonly number[]): Buffer {
  const out = Buffer.alloc(values.length * 2);
  values.forEach((value, i) => out.writeInt16LE(value, i * 2));
  return out;
}

function spawnReturning(child: FakeChild): AudioSpawn {
  return () => child;
}

describe('StreamingCapture', () => {
  it('slices the recorder stream into fixed-size frames', async () => {
    const child = new FakeChild();
    const capture = new StreamingCapture({
      command: 'parec',
      args: [],
      sampleRate: 16_000,
      channels: 1,
      frameMs: 20,
      spawn: spawnReturning(child),
    });
    const frames: Float64Array[] = [];
    capture.onFrame((frame) => frames.push(frame));
    await capture.start();
    // 320 samples per 20 ms frame; deliver two frames worth plus a partial one.
    child.emitData(pcm16(Array.from({ length: 700 }, () => 1000)));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toHaveLength(320);
    expect(frames[0]?.[0]).toBeCloseTo(1000 / 32_768, 6);
  });

  it('reports a recorder that exits as a lost device', async () => {
    const child = new FakeChild();
    const capture = new StreamingCapture({
      command: 'parec',
      args: [],
      sampleRate: 16_000,
      channels: 1,
      frameMs: 20,
      spawn: spawnReturning(child),
    });
    const errors: VoiceError[] = [];
    capture.onLost((error) => errors.push(error));
    await capture.start();
    child.close(1);
    expect(errors[0]?.kind).toBe('device_unavailable');
  });

  it('kills the recorder on stop', async () => {
    const child = new FakeChild();
    const capture = new StreamingCapture({
      command: 'parec',
      args: [],
      sampleRate: 16_000,
      channels: 1,
      frameMs: 20,
      spawn: spawnReturning(child),
    });
    await capture.start();
    await capture.stop();
    expect(child.killed).toBe(true);
  });
});

describe('PcmPlayback', () => {
  const format = { sampleRate: 24_000, channels: 1 };

  it('writes the samples to the player and resolves on a clean exit', async () => {
    const child = new FakeChild();
    const playback = new PcmPlayback({
      command: 'pacat',
      argsFor: () => ['--format=s16le'],
      spawn: spawnReturning(child),
    });
    const done = playback.play(new Int16Array([1, -2, 3]), format);
    child.close(0);
    await expect(done).resolves.toBeUndefined();
    expect(child.stdinData[0]?.length).toBe(6);
    expect(child.ended).toBe(true);
  });

  it('rejects with playback_failed when the player exits non-zero', async () => {
    const child = new FakeChild();
    const playback = new PcmPlayback({
      command: 'pacat',
      argsFor: () => [],
      spawn: spawnReturning(child),
    });
    const done = playback.play(new Int16Array([1]), format);
    await Promise.resolve();
    child.close(2);
    await expect(done).rejects.toMatchObject({ kind: 'playback_failed' });
  });

  it('interrupts playback immediately and rejects the in-flight play', async () => {
    const child = new FakeChild();
    const playback = new PcmPlayback({
      command: 'pacat',
      argsFor: () => [],
      spawn: spawnReturning(child),
    });
    const done = playback.play(new Int16Array([1, 2]), format);
    await Promise.resolve();
    await playback.stop();
    expect(child.killed).toBe(true);
    await expect(done).rejects.toMatchObject({ kind: 'cancelled' });
  });
});
