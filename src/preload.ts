import { contextBridge, ipcRenderer } from 'electron';

import { exposeAriaBridge, type IpcInvoker } from './shell/ipc.js';

const ipc: IpcInvoker = {
  invoke: (channel: string, ...args: readonly unknown[]): Promise<unknown> =>
    ipcRenderer.invoke(channel, ...args),
  send: (channel: string, ...args: readonly unknown[]): void => {
    ipcRenderer.send(channel, ...args);
  },
  on: (channel: string, listener: (...args: readonly unknown[]) => void): (() => void) => {
    const wrapped = (_event: unknown, ...args: readonly unknown[]): void => listener(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
};

exposeAriaBridge(contextBridge, ipc);
