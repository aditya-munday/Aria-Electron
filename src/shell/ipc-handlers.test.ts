import { describe, expect, it } from 'vitest';

import { registerIpcHandlers } from './ipc-handlers.js';
import { IPC_CHANNELS, type IpcHandler, type IpcRegistrar } from './ipc.js';

class RecordingRegistrar implements IpcRegistrar {
  readonly handlers = new Map<string, IpcHandler>();
  handle(channel: string, handler: IpcHandler): void {
    this.handlers.set(channel, handler);
  }
  invoke(channel: string, ...args: readonly unknown[]): unknown {
    const handler = this.handlers.get(channel);
    if (handler === undefined) throw new Error(`no handler for ${channel}`);
    return handler(...args);
  }
}

describe('main-process IPC handlers', () => {
  it('registers exactly the bridge channels and nothing more', () => {
    const registrar = new RecordingRegistrar();
    registerIpcHandlers(registrar, {
      signedIn: () => false,
      sendText: () => undefined,
      stopPlayback: () => undefined,
    });
    expect([...registrar.handlers.keys()].sort()).toEqual(
      [IPC_CHANNELS.status, IPC_CHANNELS.sendText, IPC_CHANNELS.stopPlayback].sort(),
    );
  });

  it('reports sign-in state and runtime readiness', async () => {
    const registrar = new RecordingRegistrar();
    registerIpcHandlers(registrar, {
      signedIn: () => true,
      sendText: () => undefined,
      stopPlayback: () => undefined,
    });
    expect(await registrar.invoke(IPC_CHANNELS.status)).toEqual({
      signedIn: true,
      runtime: 'ready',
    });
  });

  it('routes send-text to the host and rejects a non-string argument', async () => {
    const registrar = new RecordingRegistrar();
    const sent: string[] = [];
    registerIpcHandlers(registrar, {
      signedIn: () => false,
      sendText: (text) => {
        sent.push(text);
      },
      stopPlayback: () => undefined,
    });
    await registrar.invoke(IPC_CHANNELS.sendText, 'ship it');
    expect(sent).toEqual(['ship it']);
    await expect(registrar.invoke(IPC_CHANNELS.sendText, 42)).rejects.toThrow();
  });

  it('routes stop playback to the host', async () => {
    const registrar = new RecordingRegistrar();
    let stopped = 0;
    registerIpcHandlers(registrar, {
      signedIn: () => false,
      sendText: () => undefined,
      stopPlayback: () => {
        stopped += 1;
      },
    });
    await registrar.invoke(IPC_CHANNELS.stopPlayback);
    expect(stopped).toBe(1);
  });

  it('never exposes a token or capability channel', () => {
    const registrar = new RecordingRegistrar();
    registerIpcHandlers(registrar, {
      signedIn: () => false,
      sendText: () => undefined,
      stopPlayback: () => undefined,
    });
    for (const forbidden of ['aria:token', 'aria:capabilities', 'aria:fetch']) {
      expect(registrar.handlers.has(forbidden)).toBe(false);
    }
  });
});
