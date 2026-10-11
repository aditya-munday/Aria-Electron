import { describe, expect, it } from 'vitest';

import {
  BRIDGE_API_KEY,
  BRIDGE_METHODS,
  FORBIDDEN_BRIDGE_METHODS,
  IPC_CHANNELS,
  bridgeKeys,
  createAriaBridge,
  exposeAriaBridge,
  type ContextBridge,
  type IpcInvoker,
} from './ipc.js';

class RecordingInvoker implements IpcInvoker {
  readonly calls: { channel: string; args: readonly unknown[] }[] = [];
  async invoke(channel: string, ...args: readonly unknown[]): Promise<unknown> {
    this.calls.push({ channel, args });
    return { signedIn: false, runtime: 'ready' };
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
});
