import { InteractionController } from '../interaction/interaction-controller.js';
import type { InteractionEnvironment, RoutedResult } from '../interaction/interaction-router.js';
import { ORB_WINDOW_OPTIONS, ORB_WINDOW_SIZE } from '../orb/window-options.js';
import { placeOrb } from './placement.js';
import {
  CHAT_SHORTCUT_ACCELERATOR,
  DEFAULT_KEY_REPERTOIRE,
  type KeyEvent,
  type KeyRepertoire,
  type Platform,
  type WindowHandle,
  type WindowKind,
} from './window.js';
import type { SettingsStore, ShellSettings } from './settings.js';

function sizeFor(kind: WindowKind): { readonly width: number; readonly height: number } {
  return kind === 'orb'
    ? { width: ORB_WINDOW_SIZE, height: ORB_WINDOW_SIZE }
    : { width: 0, height: 0 };
}

export interface ShellRuntime {
  start(): void;
}

export interface ShellDeps {
  readonly platform: Platform;
  readonly runtime: ShellRuntime;
  readonly interaction: InteractionController;
  readonly settings: SettingsStore;
  readonly keys?: KeyRepertoire;
}

export class AriaShell {
  private readonly platform: Platform;
  private readonly runtime: ShellRuntime;
  private readonly interaction: InteractionController;
  private readonly settings: SettingsStore;
  private readonly keys: KeyRepertoire;
  private readonly windows = new Map<WindowKind, WindowHandle>();

  private pttHeld = false;
  private started = false;
  private pending: Promise<void> = Promise.resolve();
  private unsubscribeKeys: (() => void) | undefined;

  constructor(deps: ShellDeps) {
    this.platform = deps.platform;
    this.runtime = deps.runtime;
    this.interaction = deps.interaction;
    this.settings = deps.settings;
    this.keys = deps.keys ?? DEFAULT_KEY_REPERTOIRE;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.runtime.start();
    this.createWindow('control_center');
    this.open('control_center');
    this.platform.shortcuts.register(CHAT_SHORTCUT_ACCELERATOR, () => {
      this.enqueue(() => this.handleShortcut());
    });
    this.platform.keys.start();
    this.unsubscribeKeys = this.platform.keys.onKey((event) => {
      this.enqueue(() => this.onKey(event));
    });
  }

  whenIdle(): Promise<void> {
    return this.pending;
  }

  currentSettings(): ShellSettings {
    return this.settings.load();
  }

  updateSettings(update: (current: ShellSettings) => ShellSettings): ShellSettings {
    const next = update(this.settings.load());
    this.settings.save(next);
    this.persistOpenWindows();
    return next;
  }

  private enqueue(task: () => Promise<void>): void {
    this.pending = this.pending.then(task, task);
  }

  stop(): void {
    this.unsubscribeKeys?.();
    this.unsubscribeKeys = undefined;
    this.platform.keys.stop();
    this.started = false;
  }

  private applyRouting(result: RoutedResult): WindowKind | 'none' {
    if (result.kind === 'refused') return 'none';
    const routed = result.routed;
    if (!('surface' in routed)) return 'none';
    this.open(routed.surface);
    return routed.surface;
  }

  private async handleShortcut(): Promise<void> {
    this.applyRouting(await this.interaction.handle({ kind: 'chat_shortcut' }));
  }

  private async onKey(event: KeyEvent): Promise<void> {
    if (event.key !== this.keys.pushToTalk) return;
    if (event.kind === 'key_down') {
      if (event.repeat || this.pttHeld) return;
      this.pttHeld = true;
      this.applyRouting(await this.interaction.handle({ kind: 'push_to_talk_press' }));
      return;
    }
    if (!this.pttHeld) return;
    this.pttHeld = false;
    await this.interaction.handle({ kind: 'push_to_talk_release' });
  }

  environment(): InteractionEnvironment {
    const settings = this.settings.load();
    return {
      wakeWordEnabled: settings.wakeWordEnabled,
      microphonePermission: 'granted',
      captureMuted: settings.captureMuted,
      voiceSessionActive: false,
    };
  }

  isOpen(kind: WindowKind): boolean {
    return this.windows.get(kind)?.visible ?? false;
  }

  openWindows(): readonly WindowKind[] {
    return [...this.windows.entries()].filter(([, w]) => w.visible).map(([kind]) => kind);
  }

  open(kind: WindowKind, persist = true): WindowHandle {
    const handle = this.windows.get(kind) ?? this.createWindow(kind);
    if (kind === 'orb') {
      handle.setBounds(placeOrb(this.platform.screen.primary().workArea, sizeFor(kind)));
    }
    handle.show();
    // The Orb is a presence: borderless, always-on-top and click-through. It is
    // never focused, because taking focus would steal it from whatever the user
    // was doing when the capture activation fired.
    if (kind !== 'orb') handle.focus();
    if (persist) this.persistOpenWindows();
    return handle;
  }

  hide(kind: WindowKind): void {
    this.windows.get(kind)?.hide();
    this.persistOpenWindows();
  }

  /**
   * The Orb is click-through except on its painted circle. The renderer asks
   * for interactivity only while the pointer is over the circle; everywhere
   * else the window keeps forwarding clicks to whatever is beneath it.
   */
  setOrbInteractive(interactive: boolean): void {
    const orb = this.windows.get('orb');
    if (orb === undefined) return;
    orb.setIgnoreMouseEvents(!interactive, { forward: true });
  }

  private createWindow(kind: WindowKind): WindowHandle {
    const options =
      kind === 'orb'
        ? {
            ...ORB_WINDOW_OPTIONS,
            bounds: placeOrb(this.platform.screen.primary().workArea, sizeFor(kind)),
          }
        : { startHidden: false };
    const handle = this.platform.windows.create(kind, options);
    this.windows.set(kind, handle);
    return handle;
  }

  private persistOpenWindows(): void {
    const current = this.settings.load();
    const next: ShellSettings = {
      ...current,
      openWindows: this.openWindows().filter((kind) => kind !== 'orb'),
    };
    this.settings.save(next);
  }
}
