import type { ControlCenterState } from '../control-center/state.js';
import type { OrbState } from '../orb/state.js';
import type { ApprovalDecisionOutcome, ChatActionResult, ChatState, EmergencyStopView } from '../chat/state.js';
import type { ShellSettings } from './settings.js';

export const IPC_CHANNELS = {
  status: 'aria:status',
  sendText: 'aria:send-text',
  stopPlayback: 'aria:stop-playback',
  controlCenterState: 'aria:control-center:state',
  settingsUpdate: 'aria:control-center:settings-update',
  previewVoice: 'aria:control-center:preview-voice',
  accountSignIn: 'aria:control-center:sign-in',
  accountSignOut: 'aria:control-center:sign-out',
  orbState: 'aria:orb:state',
  orbSetInteractive: 'aria:orb:set-interactive',
  chatState: 'aria:chat:state',
  chatDecideApproval: 'aria:chat:decide-approval',
  chatAnswerQuestion: 'aria:chat:answer-question',
  chatDecidePlan: 'aria:chat:decide-plan',
  chatDecidePermission: 'aria:chat:decide-permission',
  chatCancelTask: 'aria:chat:cancel-task',
  chatMuteCapture: 'aria:chat:mute-capture',
  chatInterruptSpeech: 'aria:chat:interrupt-speech',
  chatEmergencyStop: 'aria:chat:emergency-stop',
  shellSettings: 'aria:shell:settings',
  openChat: 'aria:shell:open-chat',
} as const;

export interface ShellStatus {
  readonly signedIn: boolean;
  readonly runtime: 'ready';
}

export type SettingsUpdateResult =
  | { readonly ok: true; readonly settings: ShellSettings }
  | { readonly ok: false; readonly reason: string };

export type PreviewVoiceResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export type SignInResult =
  | { readonly ok: true; readonly signedIn: true; readonly reason?: string }
  | {
      readonly ok: false;
      readonly signedIn: false;
      readonly reason: string;
      readonly recovery?: string;
    };

export type { ApprovalDecisionOutcome, ChatActionResult, EmergencyStopView };

export interface AriaBridge {
  status(): Promise<ShellStatus>;
  sendText(text: string): Promise<void>;
  controlCenterState(): Promise<ControlCenterState>;
  updateSettings(patch: unknown): Promise<SettingsUpdateResult>;
  previewVoice(input: unknown): Promise<PreviewVoiceResult>;
  signIn(input: unknown): Promise<SignInResult>;
  signOut(): Promise<SignInResult>;
  orbState(): Promise<OrbState>;
  orbSetInteractive(interactive: boolean): Promise<void>;
  chatState(): Promise<ChatState>;
  decideApproval(input: unknown): Promise<ApprovalDecisionOutcome>;
  answerQuestion(input: unknown): Promise<ChatActionResult>;
  decidePlan(input: unknown): Promise<ChatActionResult>;
  decidePermission(input: unknown): Promise<ChatActionResult>;
  cancelTask(input: unknown): Promise<ChatActionResult>;
  muteCapture(input: unknown): Promise<ChatActionResult>;
  interruptSpeech(): Promise<ChatActionResult>;
  stopPlayback(): Promise<ChatActionResult>;
  emergencyStop(): Promise<EmergencyStopView>;
  settings(): Promise<ShellSettings>;
  openChat(): Promise<void>;
}

export const BRIDGE_API_KEY = 'aria';

export const BRIDGE_METHODS = [
  'status',
  'sendText',
  'controlCenterState',
  'updateSettings',
  'previewVoice',
  'signIn',
  'signOut',
  'orbState',
  'orbSetInteractive',
  'chatState',
  'decideApproval',
  'answerQuestion',
  'decidePlan',
  'decidePermission',
  'cancelTask',
  'muteCapture',
  'interruptSpeech',
  'stopPlayback',
  'emergencyStop',
  'settings',
  'openChat',
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
    controlCenterState: (): Promise<ControlCenterState> =>
      ipc.invoke(IPC_CHANNELS.controlCenterState) as Promise<ControlCenterState>,
    updateSettings: (patch: unknown): Promise<SettingsUpdateResult> =>
      ipc.invoke(IPC_CHANNELS.settingsUpdate, patch) as Promise<SettingsUpdateResult>,
    previewVoice: (input: unknown): Promise<PreviewVoiceResult> =>
      ipc.invoke(IPC_CHANNELS.previewVoice, input) as Promise<PreviewVoiceResult>,
    signIn: (input: unknown): Promise<SignInResult> =>
      ipc.invoke(IPC_CHANNELS.accountSignIn, input) as Promise<SignInResult>,
    signOut: (): Promise<SignInResult> =>
      ipc.invoke(IPC_CHANNELS.accountSignOut) as Promise<SignInResult>,
    orbState: (): Promise<OrbState> => ipc.invoke(IPC_CHANNELS.orbState) as Promise<OrbState>,
    orbSetInteractive: (interactive: boolean): Promise<void> =>
      ipc.invoke(IPC_CHANNELS.orbSetInteractive, interactive) as Promise<void>,
    chatState: (): Promise<ChatState> => ipc.invoke(IPC_CHANNELS.chatState) as Promise<ChatState>,
    decideApproval: (input: unknown): Promise<ApprovalDecisionOutcome> =>
      ipc.invoke(IPC_CHANNELS.chatDecideApproval, input) as Promise<ApprovalDecisionOutcome>,
    answerQuestion: (input: unknown): Promise<ChatActionResult> =>
      ipc.invoke(IPC_CHANNELS.chatAnswerQuestion, input) as Promise<ChatActionResult>,
    decidePlan: (input: unknown): Promise<ChatActionResult> =>
      ipc.invoke(IPC_CHANNELS.chatDecidePlan, input) as Promise<ChatActionResult>,
    decidePermission: (input: unknown): Promise<ChatActionResult> =>
      ipc.invoke(IPC_CHANNELS.chatDecidePermission, input) as Promise<ChatActionResult>,
    cancelTask: (input: unknown): Promise<ChatActionResult> =>
      ipc.invoke(IPC_CHANNELS.chatCancelTask, input) as Promise<ChatActionResult>,
    muteCapture: (input: unknown): Promise<ChatActionResult> =>
      ipc.invoke(IPC_CHANNELS.chatMuteCapture, input) as Promise<ChatActionResult>,
    interruptSpeech: (): Promise<ChatActionResult> =>
      ipc.invoke(IPC_CHANNELS.chatInterruptSpeech) as Promise<ChatActionResult>,
    stopPlayback: (): Promise<ChatActionResult> =>
      ipc.invoke(IPC_CHANNELS.stopPlayback) as Promise<ChatActionResult>,
    emergencyStop: (): Promise<EmergencyStopView> =>
      ipc.invoke(IPC_CHANNELS.chatEmergencyStop) as Promise<EmergencyStopView>,
    settings: (): Promise<ShellSettings> =>
      ipc.invoke(IPC_CHANNELS.shellSettings) as Promise<ShellSettings>,
    openChat: (): Promise<void> => ipc.invoke(IPC_CHANNELS.openChat) as Promise<void>,
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
