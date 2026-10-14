import { app, ipcMain, screen, session, shell as electronShell } from 'electron';

import { join } from 'node:path';

import { loadConfig } from './config.js';
import { createElectronPlatform } from './electron-platform.js';
import {
  applySessionHardening,
  applyWebContentsHardening,
  clearSessionStorage,
} from './shell/security.js';
import { InteractionController } from './interaction/interaction-controller.js';
import type { InteractionRuntime } from './interaction/interaction-controller.js';
import { AriaRuntime } from './runtime.js';
import { AriaShell } from './shell/aria-shell.js';
import { planOrbBackdrop } from './orb/backdrop.js';
import { createVoiceInteractionRuntime } from './shell/interaction-runtime.js';
import { registerIpcHandlers } from './shell/ipc-handlers.js';
import { createFileSettingsStore } from './shell/settings-file.js';
import { ErrorReporter } from './shell/error-reporting.js';
import { patchSettings } from './shell/settings.js';
import { createAutostartManager } from './shell/autostart.js';
import { CHAT_SHORTCUT_ACCELERATOR, PUSH_TO_TALK_ACCELERATOR } from './shell/window.js';
import { createNativeAudio } from './voice/native-audio.js';
import { loadVoiceConfig } from './voice/voice-config.js';
import { ControlCenterService, type SettingsSaveResult } from './control-center/control-center-service.js';
import type { PreviewVoiceResult } from './shell/ipc.js';
import { verifySignIn, type SignInOutcome } from './control-center/sign-in.js';
import { recoveryForError } from './backend/product-errors.js';
import { createControlCenterRuntime } from './control-center/control-center-runtime.js';
import { OrbService } from './orb/orb-service.js';
import { createOrbDismissal } from './orb/dismiss.js';
import { ChatService } from './chat/chat-service.js';
import { createChatControl, createChatRuntime } from './chat/chat-runtime.js';
import type { ControlCenterState, PermissionState } from './control-center/state.js';
import type { OrbState } from './orb/state.js';
import type { ApprovalDecisionOutcome, ChatActionResult, ChatState, EmergencyStopView } from './chat/state.js';
import type { ShellSettings } from './shell/settings.js';
import type { InteractionEnvironment } from './interaction/interaction-router.js';

let shellRef: AriaShell | undefined;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // A second launch would fail to grab the global shortcuts anyway (the OS
  // grants each accelerator once). Hand the focus to the running instance and
  // exit, so the shortcuts stay owned by the live process.
  app.quit();
} else {
  // A privileged renderer must never run unsandboxed: this default applies to
  // every window, including one created without explicit webPreferences.
  app.enableSandbox();
  // Features with no use here and a history of trouble: the built-in PDF
  // viewer, Chromium's spellcheck downloader, and the HTTP cache a remote
  // response could be recovered from.
  app.commandLine.appendSwitch('disable-features', 'PdfOopif,Spellcheck,NetworkServiceInProcess');
  app.commandLine.appendSwitch('disable-http-cache');
  app.on('second-instance', () => {
    shellRef?.open('control_center');
  });
  void app.whenReady().then(main);
}

function main(): void {
  const userData = app.getPath('userData');
  const settings = createFileSettingsStore(userData);
  const config = loadConfig();
  // A login launch passes `--hidden`: preload the Control Center but keep it off screen.
  const launchHidden = process.argv.includes('--hidden');
  const errors = new ErrorReporter({
    sink: (entry) => {
      process.stderr.write(`[aria] ${entry.source}: ${entry.message}\n`);
    },
  });
  process.on('uncaughtException', (error) => errors.report('uncaughtException', error));
  process.on('unhandledRejection', (reason) => errors.report('unhandledRejection', reason));

  // A renderer that escapes its own preferences must still be contained. This
  // runs for every webContents the app ever creates — including one a future
  // window kind might add — and re-applies the navigation/permission policy at
  // the process boundary.
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    applyWebContentsHardening(contents);
  });

  // The session-scoped policy (network, permissions, device/display capture) is
  // installed once, before any window exists, so no renderer can outrun it.
  applySessionHardening(session.defaultSession);

  const voiceConfig = loadVoiceConfig();
  const audio = createNativeAudio({
    frameMs: voiceConfig.vad.frameMs,
    sampleRate: voiceConfig.sampleRate,
  });
  const runtime = new AriaRuntime({
    statePath: `${userData}/supervision.json`,
    microphone: audio.microphone,
    speaker: audio.speaker,
    voiceConfig,
  });
  if (runtime.isSignedIn()) {
    process.stdout.write('[aria] Session token loaded from ARIA_SESSION_TOKEN.\n');
  } else {
    process.stdout.write('[aria] No ARIA_SESSION_TOKEN set; starting signed out.\n');
  }
  process.stdout.write(
    audio.backend.capture
      ? `[aria] Audio capture via ${audio.backend.captureCommand}.\n`
      : '[aria] No command-line audio capture tool found; push-to-talk is inert on this host.\n',
  );

  const voice = runtime.voice;
  const interactionRuntime: InteractionRuntime =
    voice !== undefined ? createVoiceInteractionRuntime(voice) : inertVoiceRuntime();

  // Signed out, the app has no account to persist settings or autostart for.
  const signedIn = (): boolean => runtime.isSignedIn();

  const applySettingsToRuntime = (next: ShellSettings): void => {
    // Local activation (push-to-talk mode, wake-word listening) works without an
    // account: gating it on sign-in would leave a signed-out user unable to
    // speak to the app at all. Only account-scoped preferences wait for sign-in.
    runtime.voice?.setPushToTalkMode(next.pushToTalkMode);
    void runtime.voice?.setWakeWordEnabled(next.wakeWordEnabled).catch((error: unknown) => {
      errors.report('settings:wakeWord', error);
    });
    if (!signedIn()) return;
    runtime.voice?.setSpeakResponses(next.speakResponses);
    runtime.voice?.setSpeechOutput({
      voice: next.voice ?? null,
      language: next.language ?? null,
      speed: next.speechRate,
    });
  };

  const autostart = createAutostartManager({
    directory: join(
      process.env.XDG_CONFIG_HOME ?? join(app.getPath('home'), '.config'),
      'autostart',
    ),
    execPath: app.getPath('exe'),
    hiddenLaunchArg: '--hidden',
  });
  const applyAutostart = (next: ShellSettings): void => {
    if (!signedIn()) return;
    const result = autostart.apply(next.startOnLogin);
    if (!result.ok) errors.report('settings:autostart', result.reason);
  };

  const microphonePermission = (): PermissionState =>
    audio.backend.capture ? 'granted' : 'denied';

  const environmentSource = (): InteractionEnvironment => ({
    wakeWordEnabled: settings.load().wakeWordEnabled,
    microphonePermission: microphonePermission(),
    captureMuted: settings.load().captureMuted,
    // A second activation while a session is live must be refused, so the router
    // needs the runtime's real state, not a constant.
    voiceSessionActive: voice?.diagnostics().sessionId !== undefined,
  });
  const interaction = new InteractionController({
    environment: environmentSource,
    runtime: interactionRuntime,
  });

  // Seed before any activation can fire, or a saved mode/wake-word is ignored.
  applySettingsToRuntime(settings.load());
  applyAutostart(settings.load());

  const shell = new AriaShell({
    platform: createElectronPlatform({
      onRendererError: (source, error) => errors.report(source, error),
      onWindowClosed: (kind) => shell.forgetWindow(kind),
    }),
    runtime,
    interaction,
    settings,
    launchHidden,
    backdrop: planOrbBackdrop(process.platform, screen.getPrimaryDisplay().bounds),
    pttAllowed: () => microphonePermission() === 'granted',
    onQuit: () => app.quit(),
  });
  settings.subscribe?.((next) => {
    applySettingsToRuntime(next);
    applyAutostart(next);
    shell.setShortcuts({ chat: next.chatShortcutEnabled, pushToTalk: next.pushToTalkEnabled });
  });

  const controlCenter = new ControlCenterService({
    runtime: createControlCenterRuntime(runtime, shell, errors),
    config,
    // A getter, so a shortcut that registers, falls back or is refused after
    // launch is reported from the live shell state rather than a stale snapshot.
    activation: () => {
      const status = shell.shortcutStatus();
      return {
        request: 'Hold F5',
        wakeWordPhrase: voiceConfig.wakeWord.phrase,
        // Report the accelerator the OS actually accepted, so the UI never
        // claims a shortcut that fell back to a different combination.
        chatAccelerator: status.chatAccelerator ?? CHAT_SHORTCUT_ACCELERATOR,
        pushToTalkAccelerator: status.pushToTalkAccelerator ?? PUSH_TO_TALK_ACCELERATOR,
        chatShortcutRegistered: status.chat,
        pushToTalkRegistered: status.pushToTalk,
        wakeWordAvailable: voice !== undefined,
        ...(voice !== undefined
          ? {}
          : { wakeWordReason: 'The wake-word engine is unavailable on this build.' }),
      };
    },
    microphonePermission,
    voiceEngine: () =>
      voice !== undefined && audio.backend.capture
        ? { kind: 'native' }
        : {
            kind: 'unavailable',
            reason: audio.backend.capture
              ? 'The voice runtime is not bound on this build.'
              : 'No command-line audio capture tool (parec, arecord or pw-record) is installed; voice capture is inert.',
          },
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
      records: () => runtime.supervisor.records(),
      orbVisible: () => shell.isOpen('orb'),
    },
  });

  const chat = new ChatService({
    runtime: createChatRuntime(
      runtime,
      createChatControl(runtime, {
        muted: settings.load().captureMuted,
        interruptLocal: () => {
          void interactionRuntime.interrupt();
        },
        persistMute: (muted) => {
          settings.save(patchSettings(settings.load(), { captureMuted: muted }));
        },
      }),
    ),
    principal: async () => (await runtime.principal()) ?? 'local',
  });

  registerIpcHandlers(ipcMain, {
    signedIn: (): boolean => runtime.isSignedIn(),
    sendText: async (text: string): Promise<void> => {
      await chat.sendText(text);
    },
    stopPlayback: (): ChatActionResult => chat.stopPlayback(),
    muteCapture: (input: unknown): ChatActionResult => {
      const muted =
        typeof input === 'object' && input !== null
          ? (input as { muted?: unknown }).muted
          : undefined;
      if (typeof muted !== 'boolean') return { ok: false, reason: 'The mute request was malformed.' };
      return chat.muteCapture(muted);
    },
    interruptSpeech: (): ChatActionResult => chat.interruptSpeech(),
    settings: () => settings.load(),
    openChat: (): void => {
      shell.open('chat');
    },
    controlCenterState: (): Promise<ControlCenterState> => controlCenter.buildState(),
    updateSettings: (patch: unknown): SettingsSaveResult => controlCenter.applySettings(patch),
    previewVoice: (input: unknown): Promise<PreviewVoiceResult> => controlCenter.previewVoice(input),
    signIn: async (input: unknown): Promise<SignInOutcome> => {
      const outcome = await verifySignIn(input, {
        sessionToken: runtime.sessionToken(),
        setSessionToken: (token) => runtime.setSessionToken(token),
        identity: () => runtime.identity(),
      });
      if (outcome.ok && outcome.signedIn) {
        // Signing in is what unlocks settings persistence and autostart, so
        // apply them now instead of waiting for an unrelated settings change.
        applySettingsToRuntime(settings.load());
        applyAutostart(settings.load());
      }
      return outcome;
    },
    signOut: (): SignInOutcome => {
      runtime.signOut();
      return { ok: true, signedIn: false, reason: 'Signed out.' };
    },
    beginLogin: async () => {
      const result = await runtime.beginLogin();
      if (!result.ok) {
        return { ok: false, reason: result.error.message, recovery: recoveryForError(result.error.kind) };
      }
      // Open the browser to the device-code URL. Only an https URL is opened;
      // a malformed or downgraded URL is reported rather than launched.
      const loginUrl = result.value.loginUrl;
      if (!/^https:\/\//i.test(loginUrl)) {
        return { ok: false, reason: 'The sign-in service returned an unsafe URL.' };
      }
      await electronShell.openExternal(loginUrl);
      return {
        ok: true,
        loginUrl,
        expiresAt: result.value.expiresAt,
        ...(result.value.expiresInMs !== undefined ? { expiresInMs: result.value.expiresInMs } : {}),
      };
    },
    awaitLogin: async () => {
      const result = await runtime.awaitLogin();
      if (result.ok) {
        applySettingsToRuntime(settings.load());
        applyAutostart(settings.load());
        return { ok: true, signedIn: true, reason: `Signed in as ${result.value.email ?? result.value.id ?? 'your account'}.` };
      }
      return {
        ok: false,
        signedIn: false,
        reason: result.error.message,
        recovery: recoveryForError(result.error.kind),
      };
    },
    cancelLogin: (): void => runtime.cancelLogin(),
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
    quit: (): void => shell.quit(),
    retryShortcuts: (): void => shell.retryShortcuts(),
    wakeWordDetected: (payload): void => {
      // The renderer owns the microphone and the VoxRT engine, so the detection
      // arrives here; run the same activation path as the local listener and
      // surface the Orb, exactly as an in-process detection would.
      if (voice === undefined) return;
      shell.setOrbVisible(true);
      void voice.activateWakeWord(payload).catch((error: unknown) => {
        errors.report('wake word', error);
      });
    },
  });

  shell.start();
  shellRef = shell;

  // The Orb is a transient presence: surface it while a voice turn runs, then
  // dismiss it a couple of seconds after the spoken output (or a failed or
  // cancelled turn) goes quiet, so it never lingers on screen permanently. The
  // "pin the Orb" setting is a manual show/hide control for the moment, not a
  // permanent overlay: it never stops the automatic dismissal.
  voice?.on((event) => {
    // The Orb belongs to a voice turn; a typed chat turn must not surface it.
    if (event.type === 'session.started' && event.source !== 'text') {
      shell.setOrbVisible(true);
    }
    // The tray's microphone control reflects the runtime's real capture state,
    // so a capture that ends on its own stops advertising "Stop listening".
    // `session.state` is the only signal that covers every end — VAD silence,
    // an empty/short utterance, a max-duration cut-off and a failure alike.
    if (event.type === 'session.state') {
      shell.setPushToTalkActive(event.state === 'capturing');
    }
  });
  const orbDismissal =
    voice !== undefined
      ? createOrbDismissal({
          voice,
          hide: () => shell.setOrbVisible(false),
          isVisible: () => shell.isOpen('orb'),
        })
      : undefined;
  orbDismissal?.start();

  void runtime.startVoice().catch(() => undefined);

  app.on('window-all-closed', () => {
    // Aria has no system tray and no windowless exit: closing a window only
    // hides it, and the process stays resident so wake word and the global
    // shortcuts keep working. Quitting is an explicit Control Center action.
  });
  app.on('will-quit', () => {
    orbDismissal?.stop();
    shell.stop();
    void runtime.stopVoice();
    // Leave no cookie, cache entry or storage record behind on disk.
    void clearSessionStorage(session.defaultSession);
  });
}

function inertVoiceRuntime(): InteractionRuntime {
  return {
    pushToTalkPress: async () => undefined,
    pushToTalkRelease: async () => undefined,
    sendText: async () => undefined,
    interrupt: async () => undefined,
  };
}

