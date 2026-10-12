import { InteractionController } from '../interaction/interaction-controller.js';
import type { InteractionEnvironment, RoutedResult } from '../interaction/interaction-router.js';
import { ORB_WINDOW_OPTIONS, ORB_WINDOW_SIZE } from '../orb/window-options.js';
import type { OrbBackdropPlan } from '../orb/backdrop.js';
import { placeOrb } from './placement.js';
import {
  CHAT_SHORTCUT_ACCELERATOR,
  DEFAULT_KEY_REPERTOIRE,
  PUSH_TO_TALK_ACCELERATOR,
  type KeyEvent,
  type KeyRepertoire,
  type Platform,
  type WindowHandle,
  type WindowKind,
  type WindowOptions,
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
  readonly backdrop?: OrbBackdropPlan;
}

export class AriaShell {
  private readonly platform: Platform;
  private readonly runtime: ShellRuntime;
  private readonly interaction: InteractionController;
  private readonly settings: SettingsStore;
  private readonly keys: KeyRepertoire;
  private readonly backdrop: OrbBackdropPlan | undefined;
  private readonly windows = new Map<WindowKind, WindowHandle>();
  private backdropOpen = false;

  private pttHeld = false;
  private pttToggled = false;
  private chatShortcutRegistered = false;
  private pushToTalkRegistered = false;
  private started = false;
  private pending: Promise<void> = Promise.resolve();
  private unsubscribeKeys: (() => void) | undefined;

  constructor(deps: ShellDeps) {
    this.platform = deps.platform;
    this.runtime = deps.runtime;
    this.interaction = deps.interaction;
    this.settings = deps.settings;
    this.keys = deps.keys ?? DEFAULT_KEY_REPERTOIRE;
    this.backdrop = deps.backdrop;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.runtime.start();
    this.createWindow('control_center');
    this.open('control_center');
    this.chatShortcutRegistered = this.platform.shortcuts.register(
      CHAT_SHORTCUT_ACCELERATOR,
      () => {
        this.enqueue(() => this.handleShortcut());
      },
    );
    // A true global grab for push-to-talk, so it works while another app has
    // focus. It only fires on key-down, so it toggles capture on and off.
    this.pushToTalkRegistered = this.platform.shortcuts.register(
      PUSH_TO_TALK_ACCELERATOR,
      () => {
        this.enqueue(() => this.togglePushToTalk());
      },
    );
    this.platform.keys.start();
    this.unsubscribeKeys = this.platform.keys.onKey((event) => {
      this.enqueue(() => this.onKey(event));
    });
    if (this.settings.load().showOrb) {
      this.open('orb');
    }
  }

  /** Whether the OS accepted each accelerator grab. Reported, never assumed. */
  shortcutStatus(): { readonly chat: boolean; readonly pushToTalk: boolean } {
    return { chat: this.chatShortcutRegistered, pushToTalk: this.pushToTalkRegistered };
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

  private async togglePushToTalk(): Promise<void> {
    if (!this.settings.load().pushToTalkEnabled) return;
    if (!this.pttToggled) {
      this.pttToggled = true;
      this.applyRouting(await this.interaction.handle({ kind: 'push_to_talk_press' }));
      return;
    }
    this.pttToggled = false;
    this.applyRouting(await this.interaction.handle({ kind: 'push_to_talk_release' }));
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

  /**
   * Show or hide the Orb presence. The Orb is the app's voice surface, so it is
   * reachable from the Control Center rather than only appearing after a voice
   * activation the user may never have been able to trigger.
   */
  setOrbVisible(visible: boolean): void {
    if (visible) {
      this.open('orb');
      return;
    }
    this.hide('orb');
  }

  /** Whether the orb backdrop is currently shown (test/diagnostics aid). */
  orbBackdropOpen(): boolean {
    return this.backdropOpen;
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
    if (kind === 'orb') this.showBackdrop();
    if (persist) this.persistOpenWindows();
    return handle;
  }

  hide(kind: WindowKind): void {
    this.windows.get(kind)?.hide();
    if (kind === 'orb') this.hideBackdrop();
    this.persistOpenWindows();
  }

  /**
   * The blur the user actually perceives is a separate full-screen window
   * sitting under the Orb; the Orb itself stays a transparent circle. When the
   * platform offers no real material, the plan says so and nothing is shown,
   * rather than drawing an opaque rectangle and calling it a blur.
   */
  orbBackdrop(): OrbBackdropPlan {
    return this.backdrop ?? { supported: false, material: 'none', reason: 'No backdrop configured.' };
  }

  private showBackdrop(): void {
    if (this.backdrop?.supported !== true || this.backdropOpen) return;
    const options = this.backdrop.options ?? ORB_WINDOW_OPTIONS;
    const handle = this.windows.get('orb_backdrop') ?? this.createWindow('orb_backdrop', options);
    handle.show();
    this.backdropOpen = true;
  }

  private hideBackdrop(): void {
    if (!this.backdropOpen) return;
    this.windows.get('orb_backdrop')?.hide();
    this.backdropOpen = false;
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

  private createWindow(kind: WindowKind, override?: WindowOptions): WindowHandle {
    const options =
      override ??
      (kind === 'orb'
        ? {
            ...ORB_WINDOW_OPTIONS,
            bounds: placeOrb(this.platform.screen.primary().workArea, sizeFor(kind)),
          }
        : { startHidden: false });
    const handle = this.platform.windows.create(kind, options);
    this.windows.set(kind, handle);
    return handle;
  }

  private persistOpenWindows(): void {
    const current = this.settings.load();
    const next: ShellSettings = {
      ...current,
      openWindows: this.openWindows().filter(
        (kind) => kind !== 'orb' && kind !== 'orb_backdrop',
      ),
    };
    this.settings.save(next);
  }
}
