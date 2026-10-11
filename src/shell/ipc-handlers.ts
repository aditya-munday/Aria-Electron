import { IPC_CHANNELS, type IpcRegistrar, type ShellStatus } from './ipc.js';

export interface IpcHost {
  signedIn(): boolean;
  sendText(text: string): Promise<void> | void;
  stopPlayback(): Promise<void> | void;
}

export function registerIpcHandlers(ipc: IpcRegistrar, host: IpcHost): void {
  ipc.handle(IPC_CHANNELS.status, (): ShellStatus => {
    return { signedIn: host.signedIn(), runtime: 'ready' };
  });
  ipc.handle(IPC_CHANNELS.sendText, async (...args: readonly unknown[]): Promise<void> => {
    const text = args[0];
    if (typeof text !== 'string') throw new Error('sendText expects a string argument');
    await host.sendText(text);
  });
  ipc.handle(IPC_CHANNELS.stopPlayback, async (): Promise<void> => {
    await host.stopPlayback();
  });
}
