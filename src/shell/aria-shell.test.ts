import { describe, expect, it } from 'vitest';

import { InteractionController } from '../interaction/interaction-controller.js';
import { AriaShell } from './aria-shell.js';
import { VoiceInteractionRuntime } from './interaction-runtime.js';
import { InMemorySettingsStore, DEFAULT_SETTINGS, type ShellSettings } from './settings.js';
import {
  CHAT_SHORTCUT_ACCELERATOR,
  DEFAULT_KEY_REPERTOIRE,
  PUSH_TO_TALK_ACCELERATOR,
  type KeyEvent,
} from './window.js';
import { ORB_RIGHT_MARGIN } from './placement.js';
import { ORB_WINDOW_SIZE } from '../orb/window-options.js';
import { planOrbBackdrop } from '../orb/backdrop.js';
import {
  FakePlatform,
  FakeShellRuntime,
  FakeVoiceRuntime,
} from './testing/doubles.js';

function key(kind: KeyEvent['kind'], repeat = false): KeyEvent {
  return { key: DEFAULT_KEY_REPERTOIRE.pushToTalk, kind, repeat };
}

function build(
  initial: ShellSettings = DEFAULT_SETTINGS,
  backdrop?: import('../orb/backdrop.js').OrbBackdropPlan,
  launchHidden = false,
  pttAllowed?: () => boolean,
  onQuit?: () => void,
  environment?: () => import('../interaction/interaction-router.js').InteractionEnvironment,
) {
  const platform = new FakePlatform();
  const runtime = new FakeShellRuntime();
  const voice = new FakeVoiceRuntime();
  const interactionRuntime = new VoiceInteractionRuntime(voice);
  const settings = new InMemorySettingsStore(initial);
  const interaction = new InteractionController({
    environment:
      environment ??
      (() => ({
        wakeWordEnabled: settings.load().wakeWordEnabled,
        microphonePermission: 'granted',
        captureMuted: settings.load().captureMuted,
        voiceSessionActive: false,
      })),
    runtime: interactionRuntime,
  });
  const shell = new AriaShell({
    platform,
    runtime,
    interaction,
    settings,
    backdrop,
    launchHidden,
    pttAllowed,
    onQuit,
  });
  return { platform, runtime, voice, interactionRuntime, settings, shell };
}

describe('shell launch', () => {
  it('opens the Control Center on a normal launch but leaves the Orb for activation', () => {
    const { shell, platform, runtime } = build();
    shell.start();
    expect(runtime.started).toBe(1);
    expect(shell.openWindows()).toEqual(['control_center']);
    expect(shell.isOpen('orb')).toBe(false);
    expect(shell.isOpen('chat')).toBe(false);
    expect(platform.windows.created.map((w) => w.kind)).toEqual(['control_center']);
  });

  it('does not create the Orb window until it is summoned', () => {
    const { shell, platform } = build();
    shell.start();
    expect(platform.windows.handle('orb')).toBeUndefined();
    shell.setOrbVisible(true);
    expect(shell.isOpen('orb')).toBe(true);
    expect(platform.windows.handle('orb')).toBeDefined();
  });

  it('toggles the Orb presence on request', () => {
    const { shell } = build({ ...DEFAULT_SETTINGS, showOrb: false });
    shell.start();
    expect(shell.isOpen('orb')).toBe(false);
    shell.setOrbVisible(true);
    expect(shell.isOpen('orb')).toBe(true);
    shell.setOrbVisible(false);
    expect(shell.isOpen('orb')).toBe(false);
  });

  it('registers the chat and push-to-talk accelerators and starts key listening', () => {
    const { shell, platform } = build();
    shell.start();
    expect(platform.shortcuts.accelerators).toEqual([
      CHAT_SHORTCUT_ACCELERATOR,
      PUSH_TO_TALK_ACCELERATOR,
    ]);
    expect(platform.keys.started).toBe(1);
    expect(shell.shortcutStatus()).toEqual({ chat: true, pushToTalk: true });
  });

  it('reports an accelerator the OS refused instead of pretending it works', () => {
    const { shell, platform } = build();
    platform.shortcuts.refused.push(PUSH_TO_TALK_ACCELERATOR);
    shell.start();
    expect(shell.shortcutStatus()).toEqual({ chat: true, pushToTalk: false });
  });

  it('does not start a capture on launch', () => {
    const { shell, interactionRuntime } = build();
    shell.start();
    expect(interactionRuntime.captureStarts()).toBe(0);
  });

  it('is idempotent across repeated starts', () => {
    const { shell, runtime } = build();
    shell.start();
    shell.start();
    expect(runtime.started).toBe(1);
    expect(shell.openWindows()).toEqual(['control_center']);
  });
});

describe('chat shortcut', () => {
  it('opens the chat window without disturbing the Orb presence', async () => {
    const { shell, platform } = build();
    shell.start();
    platform.shortcuts.fire(CHAT_SHORTCUT_ACCELERATOR);
    await shell.whenIdle();
    expect(shell.isOpen('chat')).toBe(true);
    expect(shell.isOpen('orb')).toBe(false);
  });

  it('starts no microphone capture', async () => {
    const { shell, platform, interactionRuntime } = build();
    shell.start();
    platform.shortcuts.fire(CHAT_SHORTCUT_ACCELERATOR);
    await shell.whenIdle();
    expect(interactionRuntime.captureStarts()).toBe(0);
  });
});

describe('global push-to-talk accelerator', () => {
  it('toggles capture on the first press and off on the next', async () => {
    const { shell, platform, interactionRuntime } = build();
    shell.start();
    platform.shortcuts.fire(PUSH_TO_TALK_ACCELERATOR);
    await shell.whenIdle();
    expect(interactionRuntime.captureStarts()).toBe(1);
    expect(shell.isOpen('orb')).toBe(true);
    platform.shortcuts.fire(PUSH_TO_TALK_ACCELERATOR);
    await shell.whenIdle();
    expect(interactionRuntime.captureStarts()).toBe(1);
  });

  it('does nothing while push-to-talk is disabled in settings', async () => {
    const { shell, platform, interactionRuntime } = build({
      ...DEFAULT_SETTINGS,
      pushToTalkEnabled: false,
    });
    shell.start();
    platform.shortcuts.fire(PUSH_TO_TALK_ACCELERATOR);
    await shell.whenIdle();
    expect(interactionRuntime.captureStarts()).toBe(0);
  });

  it('refuses capture when the permission gate denies, even if the toggle is on', async () => {
    const { shell, platform, interactionRuntime } = build(
      DEFAULT_SETTINGS,
      undefined,
      false,
      () => false,
    );
    shell.start();
    platform.shortcuts.fire(PUSH_TO_TALK_ACCELERATOR);
    await shell.whenIdle();
    expect(interactionRuntime.captureStarts()).toBe(0);
  });

  it('honours the permission gate for the focused push-to-talk key too', async () => {
    let allowed = true;
    const { shell, platform, interactionRuntime } = build(
      DEFAULT_SETTINGS,
      undefined,
      false,
      () => allowed,
    );
    shell.start();
    platform.keys.emit(key('key_down'));
    await shell.whenIdle();
    expect(interactionRuntime.captureStarts()).toBe(1);
    platform.keys.emit(key('key_up'));
    await shell.whenIdle();
    allowed = false;
    platform.keys.emit(key('key_down'));
    await shell.whenIdle();
    expect(interactionRuntime.captureStarts()).toBe(1);
  });

  it('registers a shortcut that was turned on after launch', async () => {
    const { shell, platform, settings, interactionRuntime } = build({
      ...DEFAULT_SETTINGS,
      pushToTalkEnabled: false,
      chatShortcutEnabled: false,
    });
    shell.start();
    expect(shell.shortcutStatus()).toEqual({ chat: false, pushToTalk: false });
    settings.save({ ...DEFAULT_SETTINGS, showOrb: true });
    shell.setShortcuts({ chat: true, pushToTalk: true });
    expect(shell.shortcutStatus()).toEqual({ chat: true, pushToTalk: true });
    platform.shortcuts.fire(CHAT_SHORTCUT_ACCELERATOR);
    await shell.whenIdle();
    platform.shortcuts.fire(PUSH_TO_TALK_ACCELERATOR);
    await shell.whenIdle();
    expect(interactionRuntime.captureStarts()).toBe(1);
  });

  it('releases a shortcut that was turned off after launch, then takes it back', () => {
    const { shell, platform } = build();
    shell.start();
    expect(shell.shortcutStatus()).toEqual({ chat: true, pushToTalk: true });
    shell.setShortcuts({ chat: false, pushToTalk: false });
    expect(shell.shortcutStatus()).toEqual({ chat: false, pushToTalk: false });
    expect(platform.shortcuts.isRegistered(CHAT_SHORTCUT_ACCELERATOR)).toBe(false);
    shell.setShortcuts({ chat: true, pushToTalk: true });
    expect(shell.shortcutStatus()).toEqual({ chat: true, pushToTalk: true });
    expect(platform.shortcuts.accelerators).toEqual([
      CHAT_SHORTCUT_ACCELERATOR,
      PUSH_TO_TALK_ACCELERATOR,
      CHAT_SHORTCUT_ACCELERATOR,
      PUSH_TO_TALK_ACCELERATOR,
    ]);
  });

  it('reports an accelerator the OS refused when it is enabled later', () => {
    const { shell, platform } = build({
      ...DEFAULT_SETTINGS,
      pushToTalkEnabled: false,
    });
    platform.shortcuts.refused.push(PUSH_TO_TALK_ACCELERATOR);
    shell.start();
    shell.setShortcuts({ pushToTalk: true });
    expect(shell.shortcutStatus()).toEqual({ chat: true, pushToTalk: false });
  });

  it('releases the global shortcuts when the shell stops', () => {
    const { shell, platform } = build();
    shell.start();
    shell.stop();
    expect(platform.shortcuts.accelerators).toEqual([
      CHAT_SHORTCUT_ACCELERATOR,
      PUSH_TO_TALK_ACCELERATOR,
    ]);
    expect(platform.shortcuts.isRegistered(CHAT_SHORTCUT_ACCELERATOR)).toBe(false);
    expect(platform.shortcuts.isRegistered(PUSH_TO_TALK_ACCELERATOR)).toBe(false);
  });

  it('finalizes on the next tap in toggle mode instead of sending a dead release', async () => {
    const { shell, platform, interactionRuntime, voice } = build({
      ...DEFAULT_SETTINGS,
      pushToTalkMode: 'toggle',
    });
    shell.start();
    platform.shortcuts.fire(PUSH_TO_TALK_ACCELERATOR);
    await shell.whenIdle();
    expect(interactionRuntime.captureStarts()).toBe(1);
    expect(voice.presses).toBe(1);
    expect(voice.releases).toBe(0);
    platform.shortcuts.fire(PUSH_TO_TALK_ACCELERATOR);
    await shell.whenIdle();
    expect(interactionRuntime.captureStarts()).toBe(2);
    expect(voice.presses).toBe(2);
    expect(voice.releases).toBe(0);
  });

  it('pairs a press with a release on the next tap in hold mode', async () => {
    const { shell, platform, interactionRuntime, voice } = build({
      ...DEFAULT_SETTINGS,
      pushToTalkMode: 'hold',
    });
    shell.start();
    platform.shortcuts.fire(PUSH_TO_TALK_ACCELERATOR);
    await shell.whenIdle();
    expect(voice.presses).toBe(1);
    expect(voice.releases).toBe(0);
    platform.shortcuts.fire(PUSH_TO_TALK_ACCELERATOR);
    await shell.whenIdle();
    expect(voice.presses).toBe(1);
    expect(voice.releases).toBe(1);
  });

  it('does not strand a held capture when push-to-talk is disabled mid-hold', async () => {
    const { shell, platform, voice, settings } = build({
      ...DEFAULT_SETTINGS,
      pushToTalkMode: 'hold',
    });
    shell.start();
    platform.shortcuts.fire(PUSH_TO_TALK_ACCELERATOR);
    await shell.whenIdle();
    expect(voice.presses).toBe(1);
    settings.save({ ...settings.load(), pushToTalkEnabled: false });
    shell.setShortcuts({ pushToTalk: false });
    await shell.whenIdle();
    // The stranded hold is released, and the accelerator is no longer grabbed.
    expect(voice.releases).toBe(1);
    expect(shell.shortcutStatus().pushToTalk).toBe(false);
  });

  it('resets the pairing state when the mode changes mid-gesture', async () => {
    const { shell, platform, voice, settings } = build({
      ...DEFAULT_SETTINGS,
      pushToTalkMode: 'hold',
    });
    shell.start();
    platform.shortcuts.fire(PUSH_TO_TALK_ACCELERATOR);
    await shell.whenIdle();
    expect(voice.presses).toBe(1);
    // Switching to toggle mid-hold, then tapping, must start a fresh capture
    // rather than pair a release from the old hold state.
    settings.save({ ...settings.load(), pushToTalkMode: 'toggle' });
    platform.shortcuts.fire(PUSH_TO_TALK_ACCELERATOR);
    await shell.whenIdle();
    expect(voice.presses).toBe(2);
    expect(voice.releases).toBe(0);
  });

  it('refuses a second activation while a voice session is active', async () => {
    let active = false;
    const { shell, platform, voice } = build(
      { ...DEFAULT_SETTINGS, pushToTalkMode: 'toggle' },
      undefined,
      false,
      undefined,
      undefined,
      () => ({
        wakeWordEnabled: true,
        microphonePermission: 'granted',
        captureMuted: false,
        voiceSessionActive: active,
      }),
    );
    shell.start();
    platform.shortcuts.fire(PUSH_TO_TALK_ACCELERATOR);
    await shell.whenIdle();
    expect(voice.presses).toBe(1);
    active = true;
    platform.shortcuts.fire(PUSH_TO_TALK_ACCELERATOR);
    await shell.whenIdle();
    // The router refuses the second activation; nothing new reaches the runtime.
    expect(voice.presses).toBe(1);
    expect(voice.releases).toBe(0);
  });
});

describe('window hiding', () => {
  it('does not quit the runtime when a window is hidden', () => {
    const { shell, runtime } = build();
    shell.start();
    shell.hide('control_center');
    expect(shell.isOpen('control_center')).toBe(false);
    expect(runtime.started).toBe(1);
    expect(shell.openWindows()).toEqual([]);
  });

  it('re-opens a hidden window without restarting the runtime', () => {
    const { shell, runtime } = build();
    shell.start();
    shell.hide('control_center');
    shell.open('control_center');
    expect(shell.isOpen('control_center')).toBe(true);
    expect(runtime.started).toBe(1);
  });

  it('keeps the runtime alive across churn of every window', () => {
    const { shell, platform, runtime } = build();
    shell.start();
    platform.shortcuts.fire(CHAT_SHORTCUT_ACCELERATOR);
    shell.hide('control_center');
    shell.hide('chat');
    shell.hide('orb');
    expect(runtime.started).toBe(1);
    expect(shell.openWindows()).toEqual([]);
  });
});

describe('push-to-talk routing', () => {
  it('routes a key-down to capture and a key-up to finalize', async () => {
    const { shell, platform, interactionRuntime, voice } = build();
    shell.start();
    platform.keys.emit(key('key_down'));
    await shell.whenIdle();
    expect(interactionRuntime.captureStarts()).toBe(1);
    expect(voice.presses).toBe(1);
    expect(shell.isOpen('orb')).toBe(true);

    platform.keys.emit(key('key_up'));
    await shell.whenIdle();
    expect(voice.releases).toBe(1);
  });

  it('does not create a second capture for a repeated key-down', async () => {
    const { shell, platform, interactionRuntime, voice } = build();
    shell.start();
    platform.keys.emit(key('key_down'));
    await shell.whenIdle();
    platform.keys.emit(key('key_down', true));
    await shell.whenIdle();
    expect(interactionRuntime.captureStarts()).toBe(1);
    expect(voice.presses).toBe(1);
  });

  it('does not create a second capture when a key-down repeats while held', async () => {
    const { shell, platform, interactionRuntime, voice } = build();
    shell.start();
    platform.keys.emit(key('key_down'));
    await shell.whenIdle();
    platform.keys.emit(key('key_down'));
    await shell.whenIdle();
    expect(interactionRuntime.captureStarts()).toBe(1);
    expect(voice.presses).toBe(1);
  });

  it('ignores a key-up with no held press', async () => {
    const { shell, platform, voice } = build();
    shell.start();
    platform.keys.emit(key('key_up'));
    await shell.whenIdle();
    expect(voice.releases).toBe(0);
  });

  it('allows a new capture after release', async () => {
    const { shell, platform, interactionRuntime, voice } = build();
    shell.start();
    platform.keys.emit(key('key_down'));
    await shell.whenIdle();
    platform.keys.emit(key('key_up'));
    await shell.whenIdle();
    platform.keys.emit(key('key_down'));
    await shell.whenIdle();
    expect(interactionRuntime.captureStarts()).toBe(2);
    expect(voice.presses).toBe(2);
    expect(voice.releases).toBe(1);
  });
});
describe('orb presence', () => {
  it('creates the Orb pre-hidden, borderless, click-through and never focused', async () => {
    const { shell, platform } = build({ ...DEFAULT_SETTINGS, showOrb: false });
    shell.start();
    platform.keys.emit(key('key_down'));
    await shell.whenIdle();
    expect(shell.isOpen('orb')).toBe(true);
    const orb = platform.windows.handle('orb');
    expect(orb?.options.startHidden).toBe(true);
    expect(orb?.options.frame).toBe(false);
    expect(orb?.options.alwaysOnTop).toBe(true);
    expect(orb?.options.clickThrough).toBe(true);
    expect(orb?.options.focusable).toBe(false);
    expect(orb?.focused).toBe(0);
    expect(orb?.shown).toBe(1);
  });

  it('is shown by the capture activation, not by launch', async () => {
    const { shell, platform } = build();
    shell.start();
    platform.shortcuts.fire(CHAT_SHORTCUT_ACCELERATOR);
    await shell.whenIdle();
    expect(shell.isOpen('orb')).toBe(false);
    platform.keys.emit(key('key_down'));
    await shell.whenIdle();
    expect(shell.isOpen('orb')).toBe(true);
  });

  it('leaves the Orb present but unchanged by a refused capture activation', async () => {
    const { shell, platform, interactionRuntime } = build({ ...DEFAULT_SETTINGS, captureMuted: true });
    shell.start();
    shell.setOrbVisible(true);
    expect(shell.isOpen('orb')).toBe(true);
    platform.keys.emit(key('key_down'));
    await shell.whenIdle();
    expect(shell.isOpen('orb')).toBe(true);
    expect(interactionRuntime.captureStarts()).toBe(0);
  });

  it('does not raise the Orb for a refused capture activation', async () => {
    const { shell, platform } = build({ ...DEFAULT_SETTINGS, captureMuted: true });
    shell.start();
    platform.keys.emit(key('key_down'));
    await shell.whenIdle();
    expect(shell.isOpen('orb')).toBe(false);
  });

  it('focuses the chat window but never the Orb', async () => {
    const { shell, platform } = build();
    shell.start();
    platform.shortcuts.fire(CHAT_SHORTCUT_ACCELERATOR);
    await shell.whenIdle();
    expect(platform.windows.handle('chat')?.focused).toBe(1);
    platform.keys.emit(key('key_down'));
    await shell.whenIdle();
    expect(platform.windows.handle('orb')?.focused).toBe(0);
  });
});



describe('orb window geometry and options', () => {
  it('places the orb at the right edge, vertically centred', async () => {
    const { shell, platform } = build();
    shell.start();
    platform.keys.emit(key('key_down'));
    await shell.whenIdle();
    const orb = platform.windows.handle('orb');
    expect(orb?.bounds).toEqual({
      x: 1440 - ORB_WINDOW_SIZE - ORB_RIGHT_MARGIN,
      y: (900 - ORB_WINDOW_SIZE) / 2,
      width: ORB_WINDOW_SIZE,
      height: ORB_WINDOW_SIZE,
    });
  });

  it('creates the orb with the real frameless, panel, shadowless options', async () => {
    const { shell, platform } = build();
    shell.start();
    platform.keys.emit(key('key_down'));
    await shell.whenIdle();
    const options = platform.windows.handle('orb')?.options;
    expect(options?.frame).toBe(false);
    expect(options?.transparent).toBe(true);
    expect(options?.alwaysOnTop).toBe(true);
    expect(options?.focusable).toBe(false);
    expect(options?.hasShadow).toBe(false);
    expect(options?.skipTaskbar).toBe(true);
    expect(options?.panel).toBe(true);
    expect(options?.bounds).toBeDefined();
  });

  it('does not focus the orb even when it is shown', async () => {
    const { shell, platform } = build();
    shell.start();
    platform.keys.emit(key('key_down'));
    await shell.whenIdle();
    expect(platform.windows.handle('orb')?.focused).toBe(0);
  });

  it('starts click-through and toggles interactivity on request', async () => {
    const { shell, platform } = build();
    shell.start();
    platform.keys.emit(key('key_down'));
    await shell.whenIdle();
    const orb = platform.windows.handle('orb');
    expect(orb?.ignoreMouse).toBe(true);
    expect(orb?.ignoreMouseForward).toBe(true);

    shell.setOrbInteractive(true);
    expect(orb?.ignoreMouse).toBe(false);
    expect(orb?.ignoreMouseForward).toBe(true);

    shell.setOrbInteractive(false);
    expect(orb?.ignoreMouse).toBe(true);
    expect(orb?.ignoreMouseForward).toBe(true);
  });

  it('ignores interactivity toggles before the orb exists', () => {
    const { shell } = build();
    expect(() => shell.setOrbInteractive(true)).not.toThrow();
  });
});

describe('orb backdrop', () => {
  it('shows the backdrop under the orb when the platform supports it', async () => {
    const plan = planOrbBackdrop('darwin', { x: 0, y: 0, width: 2560, height: 1440 });
    const { shell, platform } = build(DEFAULT_SETTINGS, plan);
    shell.start();
    platform.keys.emit(key('key_down'));
    await shell.whenIdle();
    const backdrop = platform.windows.handle('orb_backdrop');
    expect(backdrop?.visible).toBe(true);
    expect(backdrop?.options.vibrancy).toBe('under-window');
    expect(backdrop?.options.bounds).toEqual({ x: 0, y: 0, width: 2560, height: 1440 });
    expect(backdrop?.focused).toBe(0);
  });

  it('does not create a fake blur when the platform reports unsupported', async () => {
    const plan = planOrbBackdrop('linux', { x: 0, y: 0, width: 1920, height: 1080 });
    const { shell, platform } = build(DEFAULT_SETTINGS, plan);
    shell.start();
    platform.keys.emit(key('key_down'));
    await shell.whenIdle();
    expect(platform.windows.handle('orb_backdrop')).toBeUndefined();
    expect(shell.orbBackdrop().supported).toBe(false);
    expect(shell.orbBackdrop().reason).toBeDefined();
  });

  it('hides the backdrop again when the orb closes', async () => {
    const plan = planOrbBackdrop('win32', { x: 0, y: 0, width: 1920, height: 1080 });
    const { shell, platform } = build(DEFAULT_SETTINGS, plan);
    shell.start();
    platform.keys.emit(key('key_down'));
    await shell.whenIdle();
    shell.hide('orb');
    expect(platform.windows.handle('orb_backdrop')?.visible).toBe(false);
  });

  it('never persists the transient backdrop among the open windows', async () => {
    const plan = planOrbBackdrop('darwin', { x: 0, y: 0, width: 2560, height: 1440 });
    const { shell, platform, settings } = build(DEFAULT_SETTINGS, plan);
    shell.start();
    platform.keys.emit(key('key_down'));
    await shell.whenIdle();
    expect(settings.load().openWindows).not.toContain('orb_backdrop');
    expect(settings.load().openWindows).not.toContain('orb');
  });
});

describe('settings persistence', () => {
  it('persists which windows are open, excluding the activation-driven Orb', async () => {
    const { shell, platform, settings } = build();
    shell.start();
    platform.shortcuts.fire(CHAT_SHORTCUT_ACCELERATOR);
    platform.keys.emit(key('key_down'));
    await shell.whenIdle();
    expect(settings.load().openWindows).toEqual(['control_center', 'chat']);
  });

  it('never records a capture device or token as an open window', () => {
    const { shell, settings } = build();
    shell.start();
    const saved = settings.load();
    expect(Object.keys(saved)).not.toContain('token');
    expect(saved.openWindows.every((w) => w !== undefined)).toBe(true);
  });
});

describe('background launch', () => {
  it('preloads the Control Center but leaves it hidden when launched at login', () => {
    const { shell, platform } = build(DEFAULT_SETTINGS, undefined, true);
    shell.start();
    const controlCenter = platform.windows.handle('control_center');
    expect(controlCenter?.visible).toBe(false);
    expect(controlCenter?.shown).toBe(0);
    expect(controlCenter?.focused).toBe(0);
    // The runtime and the activation surfaces are still live in the background.
    expect(controlCenter).toBeDefined();
    expect(shell.isOpen('control_center')).toBe(false);
    expect(shell.isOpen('orb')).toBe(false);
  });

  it('shows the Control Center on a normal launch', () => {
    const { shell, platform } = build();
    shell.start();
    expect(platform.windows.handle('control_center')?.visible).toBe(true);
  });
});

describe('tray', () => {
  it('creates a tray with the three presence actions', () => {
    const { shell, platform } = build();
    shell.start();
    expect(platform.tray.created).toBe(1);
    expect(platform.tray.item('control-center')).toBeDefined();
    expect(platform.tray.item('chat')).toBeDefined();
    expect(platform.tray.item('orb')).toBeDefined();
    expect(shell.trayActive()).toBe(true);
  });

  it('opens and hides the Orb from the tray', async () => {
    const { shell, platform } = build();
    shell.start();
    platform.tray.item('orb')?.onClick();
    await shell.whenIdle();
    expect(shell.isOpen('orb')).toBe(true);
    platform.tray.item('orb')?.onClick();
    await shell.whenIdle();
    expect(shell.isOpen('orb')).toBe(false);
  });

  it('reports no tray when the desktop does not provide one', () => {
    const { shell, platform } = build();
    platform.tray.active = false;
    shell.start();
    expect(shell.trayActive()).toBe(false);
  });

  it('offers a Quit action only when the shell is given a way to quit', () => {
    const absent = build();
    absent.shell.start();
    expect(absent.platform.tray.item('quit')).toBeUndefined();

    let quit = 0;
    const { shell, platform } = build(DEFAULT_SETTINGS, undefined, false, undefined, () => {
      quit += 1;
    });
    shell.start();
    platform.tray.item('quit')?.onClick();
    expect(quit).toBe(1);
  });

  it('destroys the tray on stop', () => {
    const { shell, platform } = build();
    shell.start();
    shell.stop();
    expect(platform.tray.destroyed).toBe(1);
  });
});
