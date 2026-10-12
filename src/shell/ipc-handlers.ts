import type { ControlCenterState } from '../control-center/state.js';
import type { OrbState } from '../orb/state.js';
import type { ApprovalDecisionOutcome, ChatActionResult, ChatState, EmergencyStopView } from '../chat/state.js';
import type { ShellSettings } from './settings.js';
import {
  IPC_CHANNELS,
  type IpcRegistrar,
  type PreviewVoiceResult,
  type SettingsUpdateResult,
  type ShellStatus,
  type SignInResult,
} from './ipc.js';

export interface IpcHost {
  signedIn(): boolean;
  sendText(text: string): Promise<void> | void;
  stopPlayback(): ChatActionResult | Promise<ChatActionResult> | void;
  controlCenterState(): Promise<ControlCenterState>;
  updateSettings(patch: unknown): SettingsUpdateResult | Promise<SettingsUpdateResult>;
  previewVoice(input: unknown): PreviewVoiceResult | Promise<PreviewVoiceResult>;
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
  muteCapture(input: unknown): ChatActionResult | Promise<ChatActionResult>;
  interruptSpeech(): ChatActionResult | Promise<ChatActionResult>;
  emergencyStop(): EmergencyStopView | Promise<EmergencyStopView>;
  settings(): ShellSettings | Promise<ShellSettings>;
  openChat(): void | Promise<void>;
}

export function registerIpcHandlers(ipc: IpcRegistrar, host: IpcHost): void {
  ipc.handle(IPC_CHANNELS.status, (): ShellStatus => {
    return { signedIn: host.signedIn(), runtime: 'ready' };
  });
  ipc.handle(IPC_CHANNELS.sendText, async (_event: unknown, ...args: readonly unknown[]): Promise<void> => {
    const text = args[0];
    if (typeof text !== 'string') throw new Error('sendText expects a string argument');
    await host.sendText(text);
  });
  ipc.handle(
    IPC_CHANNELS.stopPlayback,
    (): ChatActionResult | Promise<ChatActionResult> | void => host.stopPlayback(),
  );
  ipc.handle(
    IPC_CHANNELS.controlCenterState,
    (): Promise<ControlCenterState> => host.controlCenterState(),
  );
  ipc.handle(
    IPC_CHANNELS.settingsUpdate,
    (_event: unknown, ...args: readonly unknown[]): SettingsUpdateResult | Promise<SettingsUpdateResult> =>
      host.updateSettings(args[0]),
  );
  ipc.handle(
    IPC_CHANNELS.previewVoice,
    (_event: unknown, ...args: readonly unknown[]): PreviewVoiceResult | Promise<PreviewVoiceResult> =>
      host.previewVoice(args[0]),
  );
  ipc.handle(
    IPC_CHANNELS.accountSignIn,
    (_event: unknown, ...args: readonly unknown[]): SignInResult | Promise<SignInResult> => host.signIn(args[0]),
  );
  ipc.handle(
    IPC_CHANNELS.accountSignOut,
    (): SignInResult | Promise<SignInResult> => host.signOut(),
  );
  ipc.handle(IPC_CHANNELS.orbState, (_event: unknown): OrbState | Promise<OrbState> => host.orbState());
  ipc.handle(
    IPC_CHANNELS.orbSetInteractive,
    (_event: unknown, ...args: readonly unknown[]): void | Promise<void> => {
      if (typeof args[0] !== 'boolean') throw new Error('orbSetInteractive expects a boolean argument');
      return host.orbSetInteractive(args[0]);
    },
  );
  ipc.handle(IPC_CHANNELS.chatState, (_event: unknown): ChatState | Promise<ChatState> => host.chatState());
  ipc.handle(
    IPC_CHANNELS.chatDecideApproval,
    (_event: unknown, ...args: readonly unknown[]): ApprovalDecisionOutcome | Promise<ApprovalDecisionOutcome> =>
      host.decideApproval(args[0]),
  );
  ipc.handle(
    IPC_CHANNELS.chatAnswerQuestion,
    (_event: unknown, ...args: readonly unknown[]): ChatActionResult | Promise<ChatActionResult> =>
      host.answerQuestion(args[0]),
  );
  ipc.handle(
    IPC_CHANNELS.chatDecidePlan,
    (_event: unknown, ...args: readonly unknown[]): ChatActionResult | Promise<ChatActionResult> =>
      host.decidePlan(args[0]),
  );
  ipc.handle(
    IPC_CHANNELS.chatDecidePermission,
    (_event: unknown, ...args: readonly unknown[]): ChatActionResult | Promise<ChatActionResult> =>
      host.decidePermission(args[0]),
  );
  ipc.handle(
    IPC_CHANNELS.chatCancelTask,
    (_event: unknown, ...args: readonly unknown[]): ChatActionResult | Promise<ChatActionResult> =>
      host.cancelTask(args[0]),
  );
  ipc.handle(
    IPC_CHANNELS.chatMuteCapture,
    (_event: unknown, ...args: readonly unknown[]): ChatActionResult | Promise<ChatActionResult> =>
      host.muteCapture(args[0]),
  );
  ipc.handle(
    IPC_CHANNELS.chatInterruptSpeech,
    (): ChatActionResult | Promise<ChatActionResult> => host.interruptSpeech(),
  );
  ipc.handle(
    IPC_CHANNELS.chatEmergencyStop,
    (): EmergencyStopView | Promise<EmergencyStopView> => host.emergencyStop(),
  );
  ipc.handle(
    IPC_CHANNELS.shellSettings,
    (): ShellSettings | Promise<ShellSettings> => host.settings(),
  );
  ipc.handle(IPC_CHANNELS.openChat, (_event: unknown): void | Promise<void> => host.openChat());
}
