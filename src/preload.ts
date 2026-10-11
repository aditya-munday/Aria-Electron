import { contextBridge, ipcRenderer } from 'electron';

import { exposeAriaBridge, type IpcInvoker } from './shell/ipc.js';

const ipc: IpcInvoker = {
  invoke: (channel: string, ...args: readonly unknown[]): Promise<unknown> =>
    ipcRenderer.invoke(channel, ...args),
};

exposeAriaBridge(contextBridge, ipc);
