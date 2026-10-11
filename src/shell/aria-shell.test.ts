import { describe, expect, it } from 'vitest';

import { InteractionController } from '../interaction/interaction-controller.js';
import { AriaShell } from './aria-shell.js';
import { VoiceInteractionRuntime } from './interaction-runtime.js';
import { InMemorySettingsStore, DEFAULT_SETTINGS, type ShellSettings } from './settings.js';
import {
  CHAT_SHORTCUT_ACCELERATOR,
  DEFAULT_KEY_REPERTOIRE,
  type KeyEvent,
} from './window.js';
import {
  FakePlatform,
  FakeShellRuntime,
  FakeVoiceRuntime,
} from './testing/doubles.js';

function key(kind: KeyEvent['kind'], repeat = false): KeyEvent {
  return { key: DEFAULT_KEY_REPERTOIRE.pushToTalk, kind, repeat };
}

function build(initial: ShellSettings = DEFAULT_SETTINGS) {
  const platform = new FakePlatform();
  const runtime = new FakeShellRuntime();
  const voice = new FakeVoiceRuntime();
  const interactionRuntime = new VoiceInteractionRuntime(voice);
  const settings = new InMemorySettingsStore(initial);
  const interaction = new InteractionController({
    environment: () => ({
      wakeWordEnabled: settings.load().wakeWordEnabled,
      microphonePermission: 'granted',
      voiceSessionActive: false,
    }),
    runtime: interactionRuntime,
  });
  const shell = new AriaShell({ platform, runtime, interaction, settings });
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

  it('registers the chat accelerator and starts key listening', () => {
    const { shell, platform } = build();
    shell.start();
    expect(platform.shortcuts.accelerators).toEqual([CHAT_SHORTCUT_ACCELERATOR]);
    expect(platform.keys.started).toBe(1);
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
