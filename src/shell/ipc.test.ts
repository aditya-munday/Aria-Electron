import { describe, expect, it } from 'vitest';

import {
  BRIDGE_API_KEY,
  BRIDGE_METHODS,
  FORBIDDEN_BRIDGE_METHODS,
  IPC_CHANNELS,
  bridgeKeys,
  createAriaBridge,
  exposeAriaBridge,
  isVoiceCaptureStartPayload,
  isVoiceCaptureStatusPayload,
  toVoicePcm,
  type ContextBridge,
  type IpcInvoker,
} from './ipc.js';

class RecordingInvoker implements IpcInvoker {
  readonly calls: { channel: string; args: readonly unknown[] }[] = [];
  private readonly listeners = new Map<string, ((...args: readonly unknown[]) => void)[]>();
  async invoke(channel: string, ...args: readonly unknown[]): Promise<unknown> {
    this.calls.push({ channel, args });
    return { signedIn: false, runtime: 'ready' };
  }
  send(channel: string, ...args: readonly unknown[]): void {
    this.calls.push({ channel, args });
  }
  on(channel: string, listener: (...args: readonly unknown[]) => void): () => void {
    const list = this.listeners.get(channel) ?? [];
    list.push(listener);
    this.listeners.set(channel, list);
    return () => {
      const current = this.listeners.get(channel) ?? [];
      this.listeners.set(
        channel,
        current.filter((entry) => entry !== listener),
      );
    };
  }
  emit(channel: string, ...args: readonly unknown[]): void {
    for (const listener of this.listeners.get(channel) ?? []) listener(...args);
  }
}

describe('preload bridge surface', () => {
  it('exposes exactly the narrow method set', () => {
    const bridge = createAriaBridge(new RecordingInvoker());
    expect(bridgeKeys(bridge)).toEqual([...BRIDGE_METHODS].sort());
  });

  it('exposes none of the privileged methods', () => {
    const bridge = createAriaBridge(new RecordingInvoker());
    const keys = bridgeKeys(bridge);
    for (const forbidden of FORBIDDEN_BRIDGE_METHODS) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('has no reachable token, network or capability accessor', () => {
    const bridge = createAriaBridge(new RecordingInvoker()) as unknown as Record<string, unknown>;
    for (const forbidden of ['token', 'fetch', 'capabilities', 'setSessionToken']) {
      expect(bridge[forbidden]).toBeUndefined();
    }
  });

  it('routes status through the status channel only', async () => {
    const invoker = new RecordingInvoker();
    const bridge = createAriaBridge(invoker);
    await bridge.status();
    expect(invoker.calls).toEqual([{ channel: IPC_CHANNELS.status, args: [] }]);
  });

  it('forwards typed text on the send-text channel', async () => {
    const invoker = new RecordingInvoker();
    const bridge = createAriaBridge(invoker);
    await bridge.sendText('hello');
    expect(invoker.calls).toEqual([{ channel: IPC_CHANNELS.sendText, args: ['hello'] }]);
  });

  it('routes stop playback on its own channel', async () => {
    const invoker = new RecordingInvoker();
    const bridge = createAriaBridge(invoker);
    await bridge.stopPlayback();
    expect(invoker.calls).toEqual([{ channel: IPC_CHANNELS.stopPlayback, args: [] }]);
  });

  it('exposes the bridge under the a single known key', () => {
    const exposed: Record<string, unknown> = {};
    const contextBridge: ContextBridge = {
      exposeInMainWorld: (key: string, api: unknown) => {
        exposed[key] = api;
      },
    };
    exposeAriaBridge(contextBridge, new RecordingInvoker());
    expect(Object.keys(exposed)).toEqual([BRIDGE_API_KEY]);
  });

  it('does not hand the renderer the raw ipc invoker', () => {
    const exposed: Record<string, unknown> = {};
    const contextBridge: ContextBridge = {
      exposeInMainWorld: (key: string, api: unknown) => {
        exposed[key] = api;
      },
    };
    const invoker = new RecordingInvoker();
    exposeAriaBridge(contextBridge, invoker);
    const api = exposed[BRIDGE_API_KEY] as Record<string, unknown>;
    expect(api['invoke']).toBeUndefined();
    expect(api['ipc']).toBeUndefined();
  });

  it('routes shell settings through the settings channel', async () => {
    const invoker = new RecordingInvoker();
    const bridge = createAriaBridge(invoker);
    await bridge.settings();
    expect(invoker.calls).toEqual([{ channel: IPC_CHANNELS.shellSettings, args: [] }]);
  });

  it('forwards captured PCM on the voice PCM channel', () => {
    const invoker = new RecordingInvoker();
    const bridge = createAriaBridge(invoker);
    const pcm = new Int16Array([1, -2, 3]);
    bridge.sendVoicePcm(pcm);
    expect(invoker.calls).toEqual([{ channel: IPC_CHANNELS.voiceCapturePcm, args: [pcm] }]);
  });

  it('reports voice status on its own channel', () => {
    const invoker = new RecordingInvoker();
    const bridge = createAriaBridge(invoker);
    bridge.reportVoiceStatus({ state: 'running' });
    expect(invoker.calls).toEqual([
      { channel: IPC_CHANNELS.voiceCaptureStatus, args: [{ state: 'running' }] },
    ]);
  });

  it('subscribes to capture start and stop, validating the start payload', () => {
    const invoker = new RecordingInvoker();
    const bridge = createAriaBridge(invoker);
    const starts: unknown[] = [];
    const stops: number[] = [];
    bridge.onVoiceCapture((payload) => starts.push(payload));
    bridge.onVoiceStop(() => stops.push(1));
    invoker.emit(IPC_CHANNELS.voiceCaptureStart, { sampleRate: 16_000, frameMs: 20 });
    invoker.emit(IPC_CHANNELS.voiceCaptureStart, { sampleRate: -1, frameMs: 20 });
    invoker.emit(IPC_CHANNELS.voiceCaptureStop);
    expect(starts).toEqual([{ sampleRate: 16_000, frameMs: 20 }]);
    expect(stops).toHaveLength(1);
  });
});

describe('voice payload validation', () => {
  it('accepts a well-formed capture start and rejects a malformed one', () => {
    expect(isVoiceCaptureStartPayload({ sampleRate: 16_000, frameMs: 20 })).toBe(true);
    expect(isVoiceCaptureStartPayload({ sampleRate: 0, frameMs: 20 })).toBe(false);
    expect(isVoiceCaptureStartPayload({ sampleRate: 16_000 })).toBe(false);
    expect(isVoiceCaptureStartPayload(null)).toBe(false);
  });

  it('accepts known capture states and rejects unknown ones', () => {
    expect(isVoiceCaptureStatusPayload({ state: 'running' })).toBe(true);
    expect(isVoiceCaptureStatusPayload({ state: 'error', detail: 'no device' })).toBe(true);
    expect(isVoiceCaptureStatusPayload({ state: 'exploded' })).toBe(false);
    expect(isVoiceCaptureStatusPayload({ state: 'error', detail: 3 })).toBe(false);
  });

  it('normalizes a typed array, a plain array, and rejects junk', () => {
    expect(toVoicePcm(new Int16Array([1, 2]))).toBeInstanceOf(Int16Array);
    expect(Array.from(toVoicePcm([1, 2, 3]) as Int16Array)).toEqual([1, 2, 3]);
    expect(toVoicePcm(new Int16Array(0))).toBeUndefined();
    expect(toVoicePcm('nope')).toBeUndefined();
    expect(toVoicePcm(null)).toBeUndefined();
  });
});
