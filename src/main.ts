import { app, ipcMain, screen } from 'electron';

import { loadConfig } from './config.js';
import { createElectronPlatform } from './electron-platform.js';
import { InteractionController } from './interaction/interaction-controller.js';
import type { InteractionRuntime } from './interaction/interaction-controller.js';
import { AriaRuntime } from './runtime.js';
import { AriaShell } from './shell/aria-shell.js';
import { planOrbBackdrop } from './orb/backdrop.js';
import { createVoiceInteractionRuntime, type VoiceRuntimeLike } from './shell/interaction-runtime.js';
import { registerIpcHandlers } from './shell/ipc-handlers.js';
import { createFileSettingsStore } from './shell/settings-file.js';
import { CHAT_SHORTCUT_ACCELERATOR } from './shell/window.js';
import { ControlCenterService, type SettingsSaveResult } from './control-center/control-center-service.js';
import { createControlCenterRuntime } from './control-center/control-center-runtime.js';
import { OrbService } from './orb/orb-service.js';
import { ChatService } from './chat/chat-service.js';
import { createChatRuntime } from './chat/chat-runtime.js';
import type { ControlCenterState, PermissionState } from './control-center/state.js';
import type { OrbState } from './orb/state.js';
import type { ApprovalDecisionOutcome, ChatActionResult, ChatState, EmergencyStopView } from './chat/state.js';
import type { InteractionEnvironment } from './interaction/interaction-router.js';

const WAKE_WORD_PHRASE = 'hey aria';

function main(): void {
  const userData = app.getPath('userData');
  const settings = createFileSettingsStore(userData);
  const config = loadConfig();
  const runtime = new AriaRuntime({ statePath: `${userData}/supervision.json` });

  const voice = runtime.voice;
  const interactionRuntime: InteractionRuntime =
    voice !== undefined ? createVoiceInteractionRuntime(voice) : inertVoiceRuntime();

  const microphonePermission = (): PermissionState =>
    voice !== undefined ? 'granted' : 'denied';

  const environmentSource = (): InteractionEnvironment => ({
    wakeWordEnabled: settings.load().wakeWordEnabled,
    microphonePermission: microphonePermission(),
    captureMuted: settings.load().captureMuted,
    voiceSessionActive: false,
  });
  const interaction = new InteractionController({
    environment: environmentSource,
    runtime: interactionRuntime,
  });

  const shell = new AriaShell({
    platform: createElectronPlatform(),
    runtime,
    interaction,
    settings,
    backdrop: planOrbBackdrop(process.platform, screen.getPrimaryDisplay().bounds),
  });

  const controlCenter = new ControlCenterService({
    runtime: createControlCenterRuntime(runtime, shell),
    config,
    activation: {
      request: 'Hold ?',
      wakeWordPhrase: WAKE_WORD_PHRASE,
      chatAccelerator: CHAT_SHORTCUT_ACCELERATOR,
      wakeWordAvailable: voice !== undefined,
      ...(voice !== undefined
        ? {}
        : { wakeWordReason: 'The wake-word engine is unavailable on this build.' }),
    },
    microphonePermission,
  });

  const orb = new OrbService({
    runtime: {
      voiceDiagnostics: () => {
        const voice = runtime.voice;
        if (voice === undefined) return undefined;
        const diagnostics = voice.diagnostics();
        return {
          listening: diagnostics.listening,
          sessionState: diagnostics.sessionState,
          wakeWordEnabled: diagnostics.wakeWordEnabled,
          ...(diagnostics.lastError !== undefined ? { lastError: diagnostics.lastError } : {}),
        };
      },
      settings: () => shell.currentSettings(),
    },
  });

  const chat = new ChatService({
    runtime: createChatRuntime(runtime),
    principal: async () => (await runtime.principal()) ?? 'local',
  });

  registerIpcHandlers(ipcMain, {
    signedIn: (): boolean => runtime.isSignedIn(),
    sendText: async (text: string): Promise<void> => {
      await chat.sendText(text);
    },
    stopPlayback: async (): Promise<void> => {
      await interactionRuntime.interrupt();
    },
    controlCenterState: (): Promise<ControlCenterState> => controlCenter.buildState(),
    updateSettings: (patch: unknown): SettingsSaveResult => controlCenter.applySettings(patch),
    signIn: (): { ok: false; reason: string; unsupported: true } => ({
      ok: false,
      reason: 'Sign-in is not available in this build yet.',
      unsupported: true,
    }),
    signOut: (): SignInOutcome => {
      runtime.setSessionToken(undefined);
      return { ok: true, signedIn: true };
    },
    orbState: (): OrbState => orb.buildState(),
    orbSetInteractive: (interactive: boolean): void => shell.setOrbInteractive(interactive),
    chatState: (): Promise<ChatState> => chat.buildState(),
    decideApproval: (input: unknown): Promise<ApprovalDecisionOutcome> =>
      chat.decideApproval(input),
    answerQuestion: (input: unknown): Promise<ChatActionResult> => chat.answerQuestion(input),
    decidePlan: (input: unknown): Promise<ChatActionResult> => chat.decidePlan(input),
    decidePermission: (input: unknown): Promise<ChatActionResult> => chat.decidePermission(input),
    cancelTask: (input: unknown): Promise<ChatActionResult> => chat.cancelTask(input),
    emergencyStop: (): Promise<EmergencyStopView> => chat.emergencyStop(),
  });

  shell.start();

  void runtime.startVoice().catch(() => undefined);

  // Keeping a handler here prevents Electron's default quit-on-last-window-close.
  app.on('window-all-closed', () => {
  });
  app.on('will-quit', () => {
    shell.stop();
    void runtime.stopVoice();
  });
}

type SignInOutcome =
  | { readonly ok: true; readonly signedIn: true }
  | { readonly ok: false; readonly reason: string; readonly unsupported?: true };

function inertVoiceRuntime(): InteractionRuntime {
  return {
    pushToTalkPress: async () => undefined,
    pushToTalkRelease: async () => undefined,
    sendText: async () => undefined,
    interrupt: async () => undefined,
  };
}

void app.whenReady().then(main);

