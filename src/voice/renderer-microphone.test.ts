import { describe, expect, it } from 'vitest';

import {
  RendererMicrophone,
  type RendererCaptureStatus,
  type RendererCaptureTransport,
} from './renderer-microphone.js';
import { isVoiceError } from './errors.js';

class FakeTransport implements RendererCaptureTransport {
  readonly starts: { sampleRate: number; frameMs: number }[] = [];
  stops = 0;
  private frameHandler: ((chunk: Int16Array) => void) | undefined;
  private statusHandler: ((status: RendererCaptureStatus) => void) | undefined;

  start(input: { sampleRate: number; frameMs: number }): void {
    this.starts.push(input);
  }
  stop(): void {
    this.stops += 1;
  }
  onFrame(handler: (chunk: Int16Array) => void): () => void {
    this.frameHandler = handler;
    return () => {
      this.frameHandler = undefined;
    };
  }
  onStatus(handler: (status: RendererCaptureStatus) => void): () => void {
    this.statusHandler = handler;
    return () => {
      this.statusHandler = undefined;
    };
  }

  emitStatus(status: RendererCaptureStatus): void {
    this.statusHandler?.(status);
  }
  emitPcm(chunk: Int16Array): void {
    this.frameHandler?.(chunk);
  }
}

function openMic(transport: FakeTransport): Promise<RendererMicrophone> {
  return (async () => {
    const mic = new RendererMicrophone({ transport, sampleRate: 16_000, frameMs: 20 });
    await mic.open({ format: { sampleRate: 16_000, channels: 1 } });
    return mic;
  })();
}

describe('RendererMicrophone', () => {
  it('sends the start command and resolves once the renderer reports running', async () => {
    const transport = new FakeTransport();
    const mic = await openMic(transport);
    const starting = mic.start();
    expect(transport.starts).toEqual([{ sampleRate: 16_000, frameMs: 20 }]);
    transport.emitStatus({ state: 'running' });
    await expect(starting).resolves.toBeUndefined();
  });

  it('re-sends the start command when the renderer reports it is idle', async () => {
    const transport = new FakeTransport();
    const mic = await openMic(transport);
    void mic.start();
    transport.emitStatus({ state: 'idle' });
    expect(transport.starts).toHaveLength(2);
    transport.emitStatus({ state: 'running' });
    transport.emitStatus({ state: 'idle' });
    // A stop was never requested, so the microphone still wants capture.
    expect(transport.starts).toHaveLength(3);
  });

  it('does not re-send after a stop', async () => {
    const transport = new FakeTransport();
    const mic = await openMic(transport);
    void mic.start();
    transport.emitStatus({ state: 'running' });
    await mic.stop();
    transport.emitStatus({ state: 'idle' });
    expect(transport.starts).toHaveLength(1);
    expect(transport.stops).toBe(1);
  });

  it('slices captured PCM into exact 20 ms frames', async () => {
    const transport = new FakeTransport();
    const mic = await openMic(transport);
    const frames: Float64Array[] = [];
    mic.onFrame((frame) => frames.push(frame));
    const starting = mic.start();
    transport.emitStatus({ state: 'running' });
    await starting;

    const chunk = new Int16Array(320);
    chunk.fill(32_767);
    transport.emitPcm(chunk);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toHaveLength(320);
    expect(frames[0]?.[0]).toBeCloseTo(1, 3);
  });

  it('carries a partial frame across chunk boundaries', async () => {
    const transport = new FakeTransport();
    const mic = await openMic(transport);
    const frames: Float64Array[] = [];
    mic.onFrame((frame) => frames.push(frame));
    const starting = mic.start();
    transport.emitStatus({ state: 'running' });
    await starting;

    transport.emitPcm(new Int16Array(100));
    expect(frames).toHaveLength(0);
    transport.emitPcm(new Int16Array(220));
    expect(frames).toHaveLength(1);
  });

  it('ignores PCM that arrives while not running', async () => {
    const transport = new FakeTransport();
    const mic = await openMic(transport);
    const frames: Float64Array[] = [];
    mic.onFrame((frame) => frames.push(frame));
    transport.emitPcm(new Int16Array(320));
    expect(frames).toHaveLength(0);
  });

  it('rejects start and reports a lost device on a capture error', async () => {
    const transport = new FakeTransport();
    const mic = await openMic(transport);
    const lost: unknown[] = [];
    mic.onLost((error) => lost.push(error));
    const starting = mic.start();
    transport.emitStatus({ state: 'error', detail: 'no device' });
    await expect(starting).rejects.toSatisfy(isVoiceError);
    expect(lost).toHaveLength(1);
    expect(isVoiceError(lost[0]) && lost[0].kind).toBe('device_unavailable');
  });

  it('reports granted permission and a default device', async () => {
    const transport = new FakeTransport();
    const mic = await openMic(transport);
    expect(await mic.permission()).toBe('granted');
    expect(await mic.captureCapableDevices()).toHaveLength(1);
  });

  it('fails a pending start when stop arrives before the renderer confirms', async () => {
    const transport = new FakeTransport();
    const mic = await openMic(transport);
    const starting = mic.start();
    await mic.stop();
    await expect(starting).rejects.toSatisfy(isVoiceError);
  });

  it('drops a partial frame when capture stops', async () => {
    const transport = new FakeTransport();
    const mic = await openMic(transport);
    const frames: Float64Array[] = [];
    mic.onFrame((frame) => frames.push(frame));
    const starting = mic.start();
    transport.emitStatus({ state: 'running' });
    await starting;
    transport.emitPcm(new Int16Array(100));
    await mic.stop();
    const restarting = mic.start();
    transport.emitStatus({ state: 'running' });
    await restarting;
    // If the pre-stop partial frame had survived, this would complete a frame.
    transport.emitPcm(new Int16Array(220));
    expect(frames).toHaveLength(0);
  });
});
