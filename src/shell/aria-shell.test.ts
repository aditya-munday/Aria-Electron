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
) {
  const platform = new FakePlatform();
  const runtime = new FakeShellRuntime();
  const voice = new FakeVoiceRuntime();
  const interactionRuntime = new VoiceInteractionRuntime(voice);
  const settings = new InMemorySettingsStore(initial);
  const interaction = new InteractionController({
    environment: () => ({
      wakeWordEnabled: settings.load().wakeWordEnabled,
      microphonePermission: 'granted',
      captureMuted: settings.load().captureMuted,
      voiceSessionActive: false,
    }),
    runtime: interactionRuntime,
  });
  const shell = new AriaShell({ platform, runtime, interaction, settings, backdrop });
  return { platform, runtime, voice, interactionRuntime, settings, shell };
}

describe('shell launch', () => {
  it('opens only the Control Center on a normal launch', () => {
    const { shell, platform, runtime } = build();
    shell.start();
    expect(runtime.started).toBe(1);
    expect(shell.openWindows()).toEqual(['control_center']);
    expect(shell.isOpen('orb')).toBe(false);
    expect(shell.isOpen('chat')).toBe(false);
    expect(platform.windows.created.map((w) => w.kind)).toEqual(['control_center']);
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
    expect(shell.isOpen('orb')).toBe(false);
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
  it('opens the chat window and not the Orb', async () => {
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
    expect(shell.isOpen('orb')).toBe(false);
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
    expect(shell.isOpen('orb')).toBe(false);
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
    const { shell, platform } = build();
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

  it('is never raised by launch or the chat shortcut', async () => {
    const { shell, platform } = build();
    shell.start();
    platform.shortcuts.fire(CHAT_SHORTCUT_ACCELERATOR);
    await shell.whenIdle();
    expect(platform.windows.handle('orb')).toBeUndefined();
    expect(shell.isOpen('orb')).toBe(false);
  });

  it('raises only for a capture activation, not a refused one', async () => {
    const { shell, platform } = build({ ...DEFAULT_SETTINGS, captureMuted: true });
    shell.start();
    platform.keys.emit(key('key_down'));
    await shell.whenIdle();
    expect(shell.isOpen('orb')).toBe(false);
    expect(platform.windows.handle('orb')).toBeUndefined();
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
  it('places the orb at the right edge, two sixths down the work area', async () => {
    const { shell, platform } = build();
    shell.start();
    platform.keys.emit(key('key_down'));
    await shell.whenIdle();
    const orb = platform.windows.handle('orb');
    expect(orb?.bounds).toEqual({
      x: 1440 - ORB_WINDOW_SIZE - ORB_RIGHT_MARGIN,
      y: (900 * 2) / 6,
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
