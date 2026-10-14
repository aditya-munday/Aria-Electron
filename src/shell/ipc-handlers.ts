import type { ControlCenterState } from '../control-center/state.js';
import type { OrbState } from '../orb/state.js';
import type { ApprovalDecisionOutcome, ChatActionResult, ChatState, EmergencyStopView } from '../chat/state.js';
import type { ShellSettings } from './settings.js';
import { isTrustedSender, type IpcSenderEvent } from './security.js';
import {
  IPC_CHANNELS,
  isWakeWordPayload,
  type AwaitLoginResult,
  type BeginLoginResult,
  type IpcRegistrar,
  type PreviewVoiceResult,
  type SettingsUpdateResult,
  type ShellStatus,
  type SignInResult,
  type WakeWordDetectionPayload,
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
  beginLogin(): BeginLoginResult | Promise<BeginLoginResult>;
  awaitLogin(): AwaitLoginResult | Promise<AwaitLoginResult>;
  cancelLogin(): void | Promise<void>;
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
  /** Quit Aria on the user's explicit request. */
  quit(): void | Promise<void>;
  /** Re-attempt the global shortcut grabs after another app freed one. */
  retryShortcuts(): void | Promise<void>;
  /** A wake-word detection reported by a renderer. */
  wakeWordDetected(payload: WakeWordDetectionPayload): void | Promise<void>;
}

export function registerIpcHandlers(ipc: IpcRegistrar, host: IpcHost): void {
  const handle = (channel: string, fn: (...args: readonly unknown[]) => unknown): void => {
    ipc.handle(channel, (event: unknown, ...args: readonly unknown[]): unknown => {
      if (!isTrustedSender(event as IpcSenderEvent)) {
        throw new Error(`Refused IPC on ${channel} from an untrusted sender.`);
      }
      return fn(...args);
    });
  };

  handle(IPC_CHANNELS.status, (): ShellStatus => {
    return { signedIn: host.signedIn(), runtime: 'ready' };
  });
  handle(IPC_CHANNELS.sendText, async (...args: readonly unknown[]): Promise<void> => {
    const text = args[0];
    if (typeof text !== 'string') throw new Error('sendText expects a string argument');
    await host.sendText(text);
  });
  handle(
    IPC_CHANNELS.stopPlayback,
    (): ChatActionResult | Promise<ChatActionResult> | void => host.stopPlayback(),
  );
  handle(
    IPC_CHANNELS.controlCenterState,
    (): Promise<ControlCenterState> => host.controlCenterState(),
  );
  handle(
    IPC_CHANNELS.settingsUpdate,
    (...args: readonly unknown[]): SettingsUpdateResult | Promise<SettingsUpdateResult> =>
      host.updateSettings(args[0]),
  );
  handle(
    IPC_CHANNELS.previewVoice,
    (...args: readonly unknown[]): PreviewVoiceResult | Promise<PreviewVoiceResult> =>
      host.previewVoice(args[0]),
  );
  handle(
    IPC_CHANNELS.accountSignIn,
    (...args: readonly unknown[]): SignInResult | Promise<SignInResult> => host.signIn(args[0]),
  );
  handle(
    IPC_CHANNELS.accountSignOut,
    (): SignInResult | Promise<SignInResult> => host.signOut(),
  );
  handle(
    IPC_CHANNELS.accountBeginLogin,
    (): BeginLoginResult | Promise<BeginLoginResult> => host.beginLogin(),
  );
  handle(
    IPC_CHANNELS.accountAwaitLogin,
    (): AwaitLoginResult | Promise<AwaitLoginResult> => host.awaitLogin(),
  );
  handle(IPC_CHANNELS.accountCancelLogin, (): void | Promise<void> => host.cancelLogin());
  handle(IPC_CHANNELS.orbState, (): OrbState | Promise<OrbState> => host.orbState());
  handle(
    IPC_CHANNELS.orbSetInteractive,
    (...args: readonly unknown[]): void | Promise<void> => {
      if (typeof args[0] !== 'boolean') throw new Error('orbSetInteractive expects a boolean argument');
      return host.orbSetInteractive(args[0]);
    },
  );
  handle(IPC_CHANNELS.chatState, (): ChatState | Promise<ChatState> => host.chatState());
  handle(
    IPC_CHANNELS.chatDecideApproval,
    (...args: readonly unknown[]): ApprovalDecisionOutcome | Promise<ApprovalDecisionOutcome> =>
      host.decideApproval(args[0]),
  );
  handle(
    IPC_CHANNELS.chatAnswerQuestion,
    (...args: readonly unknown[]): ChatActionResult | Promise<ChatActionResult> =>
      host.answerQuestion(args[0]),
  );
  handle(
    IPC_CHANNELS.chatDecidePlan,
    (...args: readonly unknown[]): ChatActionResult | Promise<ChatActionResult> =>
      host.decidePlan(args[0]),
  );
  handle(
    IPC_CHANNELS.chatDecidePermission,
    (...args: readonly unknown[]): ChatActionResult | Promise<ChatActionResult> =>
      host.decidePermission(args[0]),
  );
  handle(
    IPC_CHANNELS.chatCancelTask,
    (...args: readonly unknown[]): ChatActionResult | Promise<ChatActionResult> =>
      host.cancelTask(args[0]),
  );
  handle(
    IPC_CHANNELS.chatMuteCapture,
    (...args: readonly unknown[]): ChatActionResult | Promise<ChatActionResult> =>
      host.muteCapture(args[0]),
  );
  handle(
    IPC_CHANNELS.chatInterruptSpeech,
    (): ChatActionResult | Promise<ChatActionResult> => host.interruptSpeech(),
  );
  handle(
    IPC_CHANNELS.chatEmergencyStop,
    (): EmergencyStopView | Promise<EmergencyStopView> => host.emergencyStop(),
  );
  handle(
    IPC_CHANNELS.shellSettings,
    (): ShellSettings | Promise<ShellSettings> => host.settings(),
  );
  handle(IPC_CHANNELS.openChat, (): void | Promise<void> => host.openChat());
  handle(IPC_CHANNELS.shellQuit, (): void | Promise<void> => host.quit());
  handle(IPC_CHANNELS.shellRetryShortcuts, (): void | Promise<void> => host.retryShortcuts());
  ipc.on(IPC_CHANNELS.wakeWordDetected, (event: unknown, ...args: readonly unknown[]): void => {
    if (!isTrustedSender(event as IpcSenderEvent)) return;
    const payload = args[0];
    if (!isWakeWordPayload(payload)) return;
    void host.wakeWordDetected(payload);
  });
}
