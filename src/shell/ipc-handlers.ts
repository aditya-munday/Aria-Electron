import type { ControlCenterState } from '../control-center/state.js';
import type { OrbState } from '../orb/state.js';
import {
  IPC_CHANNELS,
  type IpcRegistrar,
  type SettingsUpdateResult,
  type ShellStatus,
  type SignInResult,
} from './ipc.js';

export interface IpcHost {
  signedIn(): boolean;
  sendText(text: string): Promise<void> | void;
  stopPlayback(): Promise<void> | void;
  controlCenterState(): Promise<ControlCenterState>;
  updateSettings(patch: unknown): SettingsUpdateResult | Promise<SettingsUpdateResult>;
  signIn(input: unknown): SignInResult | Promise<SignInResult>;
  signOut(): SignInResult | Promise<SignInResult>;
  orbState(): OrbState | Promise<OrbState>;
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
  ipc.handle(
    IPC_CHANNELS.controlCenterState,
    (): Promise<ControlCenterState> => host.controlCenterState(),
  );
  ipc.handle(
    IPC_CHANNELS.settingsUpdate,
    (...args: readonly unknown[]): SettingsUpdateResult | Promise<SettingsUpdateResult> =>
      host.updateSettings(args[0]),
  );
  ipc.handle(
    IPC_CHANNELS.accountSignIn,
    (...args: readonly unknown[]): SignInResult | Promise<SignInResult> => host.signIn(args[0]),
  );
  ipc.handle(
    IPC_CHANNELS.accountSignOut,
    (): SignInResult | Promise<SignInResult> => host.signOut(),
  );
  ipc.handle(IPC_CHANNELS.orbState, (): OrbState | Promise<OrbState> => host.orbState());
}
