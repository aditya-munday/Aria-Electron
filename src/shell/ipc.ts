export const IPC_CHANNELS = {
  status: 'aria:status',
  sendText: 'aria:send-text',
  stopPlayback: 'aria:stop-playback',
} as const;

export interface ShellStatus {
  readonly signedIn: boolean;
  readonly runtime: 'ready';
}

export interface AriaBridge {
  status(): Promise<ShellStatus>;
  sendText(text: string): Promise<void>;
  stopPlayback(): Promise<void>;
}

export const BRIDGE_API_KEY = 'aria';

export const BRIDGE_METHODS = ['sendText', 'status', 'stopPlayback'] as const;

export const FORBIDDEN_BRIDGE_METHODS = [
  'token',
  'setSessionToken',
  'capabilities',
  'fetch',
  'request',
  'chat',
  'stt',
  'tts',
  'supervisor',
] as const;

export interface IpcInvoker {
  invoke(channel: string, ...args: readonly unknown[]): Promise<unknown>;
}

export type IpcHandler = (...args: readonly unknown[]) => unknown;

export interface IpcRegistrar {
  handle(channel: string, handler: IpcHandler): void;
}

export function createAriaBridge(ipc: IpcInvoker): AriaBridge {
  return {
    status: (): Promise<ShellStatus> => ipc.invoke(IPC_CHANNELS.status) as Promise<ShellStatus>,
    sendText: (text: string): Promise<void> =>
      ipc.invoke(IPC_CHANNELS.sendText, text) as Promise<void>,
    stopPlayback: (): Promise<void> =>
      ipc.invoke(IPC_CHANNELS.stopPlayback) as Promise<void>,
  };
}

export function bridgeKeys(bridge: AriaBridge): readonly string[] {
  return Object.keys(bridge).sort();
}

export interface ContextBridge {
  exposeInMainWorld(key: string, api: unknown): void;
}

export function exposeAriaBridge(contextBridge: ContextBridge, ipc: IpcInvoker): void {
  contextBridge.exposeInMainWorld(BRIDGE_API_KEY, createAriaBridge(ipc));
}
