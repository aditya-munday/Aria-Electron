import type { ControlCenterState } from '../control-center/state.js';
import type { ShellSettings } from './settings.js';

export const IPC_CHANNELS = {
  status: 'aria:status',
  sendText: 'aria:send-text',
  stopPlayback: 'aria:stop-playback',
  controlCenterState: 'aria:control-center:state',
  settingsUpdate: 'aria:control-center:settings-update',
  accountSignIn: 'aria:control-center:sign-in',
  accountSignOut: 'aria:control-center:sign-out',
} as const;

export interface ShellStatus {
  readonly signedIn: boolean;
  readonly runtime: 'ready';
}

export type SettingsUpdateResult =
  | { readonly ok: true; readonly settings: ShellSettings }
  | { readonly ok: false; readonly reason: string };

export type SignInResult =
  | { readonly ok: true; readonly signedIn: true }
  | { readonly ok: false; readonly reason: string; readonly unsupported?: true };

export interface AriaBridge {
  status(): Promise<ShellStatus>;
  sendText(text: string): Promise<void>;
  stopPlayback(): Promise<void>;
  controlCenterState(): Promise<ControlCenterState>;
  updateSettings(patch: unknown): Promise<SettingsUpdateResult>;
  signIn(input: unknown): Promise<SignInResult>;
  signOut(): Promise<SignInResult>;
}

export const BRIDGE_API_KEY = 'aria';

export const BRIDGE_METHODS = [
  'status',
  'sendText',
  'stopPlayback',
  'controlCenterState',
  'updateSettings',
  'signIn',
  'signOut',
] as const;

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
  'identity',
  'ipcRenderer',
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
    controlCenterState: (): Promise<ControlCenterState> =>
      ipc.invoke(IPC_CHANNELS.controlCenterState) as Promise<ControlCenterState>,
    updateSettings: (patch: unknown): Promise<SettingsUpdateResult> =>
      ipc.invoke(IPC_CHANNELS.settingsUpdate, patch) as Promise<SettingsUpdateResult>,
    signIn: (input: unknown): Promise<SignInResult> =>
      ipc.invoke(IPC_CHANNELS.accountSignIn, input) as Promise<SignInResult>,
    signOut: (): Promise<SignInResult> =>
      ipc.invoke(IPC_CHANNELS.accountSignOut) as Promise<SignInResult>,
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
