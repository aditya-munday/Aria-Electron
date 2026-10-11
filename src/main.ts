import { app, ipcMain } from 'electron';

import { createElectronPlatform } from './electron-platform.js';
import { InteractionController } from './interaction/interaction-controller.js';
import { AriaRuntime } from './runtime.js';
import { AriaShell } from './shell/aria-shell.js';
import { createVoiceInteractionRuntime, type VoiceRuntimeLike } from './shell/interaction-runtime.js';
import { registerIpcHandlers } from './shell/ipc-handlers.js';
import { createFileSettingsStore } from './shell/settings-file.js';
import type { InteractionEnvironment } from './interaction/interaction-router.js';

function main(): void {
  const settings = createFileSettingsStore(app.getPath('userData'));
  const runtime = new AriaRuntime({ statePath: `${app.getPath('userData')}/supervision.json` });

  const voice = runtime.voice;
  const interactionRuntime =
    voice !== undefined
      ? createVoiceInteractionRuntime(voice)
      : inertVoiceRuntime();

  const environmentSource = (): InteractionEnvironment => ({
    wakeWordEnabled: settings.load().wakeWordEnabled,
    microphonePermission: 'granted',
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
  });

  registerIpcHandlers(ipcMain, {
    signedIn: (): boolean => runtime.isSignedIn(),
    sendText: async (text: string): Promise<void> => {
      await interactionRuntime.sendText(text);
    },
    stopPlayback: async (): Promise<void> => {
      await interactionRuntime.interrupt();
    },
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

function inertVoiceRuntime(): VoiceRuntimeLike {
  return {
    pushToTalkPress: async () => undefined,
    pushToTalkRelease: async () => undefined,
    sendText: async () => undefined,
    interrupt: async () => undefined,
  };
}

void app.whenReady().then(main);
