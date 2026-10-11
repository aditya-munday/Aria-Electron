import type { ControlCenterState } from '../control-center/state.js';
import type { OrbState } from '../orb/state.js';
import type { ApprovalDecisionOutcome, ChatActionResult, ChatState, EmergencyStopView } from '../chat/state.js';
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
  orbSetInteractive(interactive: boolean): void | Promise<void>;
  chatState(): ChatState | Promise<ChatState>;
  decideApproval(input: unknown): ApprovalDecisionOutcome | Promise<ApprovalDecisionOutcome>;
  answerQuestion(input: unknown): ChatActionResult | Promise<ChatActionResult>;
  decidePlan(input: unknown): ChatActionResult | Promise<ChatActionResult>;
  decidePermission(input: unknown): ChatActionResult | Promise<ChatActionResult>;
  cancelTask(input: unknown): ChatActionResult | Promise<ChatActionResult>;
  emergencyStop(): EmergencyStopView | Promise<EmergencyStopView>;
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
  ipc.handle(
    IPC_CHANNELS.orbSetInteractive,
    (...args: readonly unknown[]): void | Promise<void> => {
      if (typeof args[0] !== 'boolean') throw new Error('orbSetInteractive expects a boolean argument');
      return host.orbSetInteractive(args[0]);
    },
  );
  ipc.handle(IPC_CHANNELS.chatState, (): ChatState | Promise<ChatState> => host.chatState());
  ipc.handle(
    IPC_CHANNELS.chatDecideApproval,
    (...args: readonly unknown[]): ApprovalDecisionOutcome | Promise<ApprovalDecisionOutcome> =>
      host.decideApproval(args[0]),
  );
  ipc.handle(
    IPC_CHANNELS.chatAnswerQuestion,
    (...args: readonly unknown[]): ChatActionResult | Promise<ChatActionResult> =>
      host.answerQuestion(args[0]),
  );
  ipc.handle(
    IPC_CHANNELS.chatDecidePlan,
    (...args: readonly unknown[]): ChatActionResult | Promise<ChatActionResult> =>
      host.decidePlan(args[0]),
  );
  ipc.handle(
    IPC_CHANNELS.chatDecidePermission,
    (...args: readonly unknown[]): ChatActionResult | Promise<ChatActionResult> =>
      host.decidePermission(args[0]),
  );
  ipc.handle(
    IPC_CHANNELS.chatCancelTask,
    (...args: readonly unknown[]): ChatActionResult | Promise<ChatActionResult> =>
      host.cancelTask(args[0]),
  );
  ipc.handle(
    IPC_CHANNELS.chatEmergencyStop,
    (): EmergencyStopView | Promise<EmergencyStopView> => host.emergencyStop(),
  );
}
