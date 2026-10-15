import { InteractionController } from '../interaction/interaction-controller.js';
import type { RoutedResult } from '../interaction/interaction-router.js';
import { ORB_DIAMETER, ORB_WINDOW_OPTIONS, ORB_WINDOW_SIZE } from '../orb/window-options.js';
import type { OrbBackdropPlan } from '../orb/backdrop.js';
import { placeOrb } from './placement.js';
import {
  CHAT_SHORTCUT_ACCELERATORS,
  DEFAULT_KEY_REPERTOIRE,
  PUSH_TO_TALK_ACCELERATORS,
  type KeyEvent,
  type KeyRepertoire,
  type Platform,
  type PushToTalkMode,
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
  /**
   * Whether a push-to-talk gesture is currently permitted. When provided, every
   * push-to-talk path consults it before capture so a disabled push-to-talk
   * never opens the microphone — including a global accelerator fired while
   * another app has focus, which never passes through the settings UI.
   */
  readonly pttAllowed?: () => boolean;
  /**
   * Launch straight into the background: preload the Control Center but keep it
   * hidden. Used when the app starts at login, so it does not steal the screen.
   */
  readonly launchHidden?: boolean;
  /**
   * Called when the user asks to quit from the Control Center. The shell does
   * not own `app`, so it reports the request and lets the composition root quit.
   */
  readonly onQuit?: () => void;
}

export class AriaShell {
  private readonly platform: Platform;
  private readonly runtime: ShellRuntime;
  private readonly interaction: InteractionController;
  private readonly settings: SettingsStore;
  private readonly keys: KeyRepertoire;
  private readonly backdrop: OrbBackdropPlan | undefined;
  private readonly launchHidden: boolean;
  private readonly windows = new Map<WindowKind, WindowHandle>();
  private backdropOpen = false;

  private pttHeld = false;
  private pttToggled = false;
  private pttActive = false;
  private pttAcceleratorMode: PushToTalkMode | undefined;
  private chatShortcutRegistered = false;
  private pushToTalkRegistered = false;
  private chatAccelerator: string | undefined;
  private pttAccelerator: string | undefined;
  private chatShortcutRequested: boolean | undefined;
  private pushToTalkRequested: boolean | undefined;
  private started = false;
  private readonly pttAllowed: (() => boolean) | undefined;
  private readonly onQuit: (() => void) | undefined;
  private pending: Promise<void> = Promise.resolve();
  private unsubscribeKeys: (() => void) | undefined;

  constructor(deps: ShellDeps) {
    this.platform = deps.platform;
    this.runtime = deps.runtime;
    this.interaction = deps.interaction;
    this.settings = deps.settings;
    this.keys = deps.keys ?? DEFAULT_KEY_REPERTOIRE;
    this.backdrop = deps.backdrop;
    this.launchHidden = deps.launchHidden === true;
    this.pttAllowed = deps.pttAllowed;
    this.onQuit = deps.onQuit;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const settings = this.settings.load();
    this.chatShortcutRequested = settings.chatShortcutEnabled;
    this.pushToTalkRequested = settings.pushToTalkEnabled;
    this.runtime.start();
    this.createWindow('control_center', { startHidden: false, launchHidden: this.launchHidden });
    this.open('control_center');
    this.syncShortcuts();
    this.platform.keys.start();
    this.unsubscribeKeys = this.platform.keys.onKey((event) => {
      this.enqueue(() => this.onKey(event));
    });
  }

  /** Whether the OS accepted each accelerator grab. Reported, never assumed. */
  shortcutStatus(): {
    readonly chat: boolean;
    readonly pushToTalk: boolean;
    readonly chatAccelerator?: string;
    readonly pushToTalkAccelerator?: string;
  } {
    return {
      chat: this.chatShortcutRegistered,
      pushToTalk: this.pushToTalkRegistered,
      ...(this.chatAccelerator !== undefined ? { chatAccelerator: this.chatAccelerator } : {}),
      ...(this.pttAccelerator !== undefined ? { pushToTalkAccelerator: this.pttAccelerator } : {}),
    };
  }

  /**
   * Enable or disable the global chat and push-to-talk shortcuts at run time.
   *
   * The OS grab is what makes them work without the app focused, so a toggle in
   * the Control Center has to add or release the grab, not merely store a flag.
   * Enabling re-registers and reports whether the OS accepted; disabling
   * releases so another application can take the accelerator.
   */
  setShortcuts(options: { readonly chat?: boolean; readonly pushToTalk?: boolean }): void {
    if (options.chat !== undefined) {
      this.chatShortcutRequested = options.chat;
    }
    if (options.pushToTalk !== undefined) {
      this.pushToTalkRequested = options.pushToTalk;
      if (!options.pushToTalk) {
        // Disabling push-to-talk must not strand a held capture: release it so
        // the microphone does not run with no way to stop it.
        void this.enqueue(() => this.releaseStrandedPtt());
      }
    }
    this.syncShortcuts();
  }

  /** Release a push-to-talk capture that no further key event can finalize. */
  private async releaseStrandedPtt(): Promise<void> {
    const acceleratorHold = this.pttToggled && this.settings.load().pushToTalkMode === 'hold';
    if (this.pttHeld || acceleratorHold) {
      this.pttHeld = false;
      await this.interaction.handle({ kind: 'push_to_talk_release' });
    }
    this.pttToggled = false;
  }

  /**
   * Track the runtime's real capture state so no control can disagree with it.
   *
   * `pttActive` is settled only by the runtime: a VAD silence, an empty/short
   * utterance, a max-duration cut-off or an error all end the session without a
   * second tap. The next tap in hold mode is therefore a press, not a release
   * for a capture that already finished.
   */
  setPushToTalkActive(active: boolean): void {
    if (this.pttActive === active) return;
    this.pttActive = active;
    if (!active) this.pttToggled = false;
  }

  /**
   * Reconcile the requested shortcuts with what the OS currently holds. The
   * requested state is persisted settings; the held state is the last grab the
   * OS accepted. Only a change is applied, so a repeated sync is inert.
   *
   * Each shortcut walks its candidate accelerators and keeps the first the OS
   * accepts: a desktop environment that has already taken the preferred grab
   * would otherwise leave push-to-talk silently dead.
   */
  private syncShortcuts(): void {
    const shortcuts = this.platform.shortcuts;

    if (this.chatShortcutRequested) {
      if (this.chatAccelerator === undefined) {
        this.chatAccelerator = this.registerFirst(
          CHAT_SHORTCUT_ACCELERATORS,
          () => this.enqueue(() => this.handleShortcut()),
        );
        this.chatShortcutRegistered = this.chatAccelerator !== undefined;
      }
    } else if (this.chatAccelerator !== undefined) {
      shortcuts.unregister(this.chatAccelerator);
      this.chatAccelerator = undefined;
      this.chatShortcutRegistered = false;
    }

    // A true global grab for push-to-talk, so it works while another app has
    // focus. The OS only reports the key-down, so each tap is a press and the
    // shell decides whether to pair it with a release based on the mode.
    if (this.pushToTalkRequested) {
      if (this.pttAccelerator === undefined) {
        this.pttAccelerator = this.registerFirst(
          PUSH_TO_TALK_ACCELERATORS,
          () => this.enqueue(() => this.activatePushToTalk()),
        );
        this.pushToTalkRegistered = this.pttAccelerator !== undefined;
      }
    } else if (this.pttAccelerator !== undefined) {
      shortcuts.unregister(this.pttAccelerator);
      this.pttAccelerator = undefined;
      this.pushToTalkRegistered = false;
    }
  }

  /** Register the first accelerator the OS accepts; `undefined` if none is free. */
  private registerFirst(
    candidates: readonly string[],
    handler: () => void,
  ): string | undefined {
    for (const accelerator of candidates) {
      if (this.platform.shortcuts.register(accelerator, handler)) return accelerator;
    }
    return undefined;
  }

  /**
   * End the process on the user's explicit request. Aria deliberately has no
   * system tray: the only way to stop it is this Control Center control, which
   * warns that Aria will stop listening and will not be available for help
   * until it is launched again. Closing a window never quits; Aria stays
   * resident so it is still there when help is needed.
   */
  quit(): void {
    this.onQuit?.();
  }

  /** Release both grabs and take them again, e.g. after another app freed one. */
  retryShortcuts(): void {
    if (this.chatAccelerator !== undefined) {
      this.platform.shortcuts.unregister(this.chatAccelerator);
      this.chatAccelerator = undefined;
      this.chatShortcutRegistered = false;
    }
    if (this.pttAccelerator !== undefined) {
      this.platform.shortcuts.unregister(this.pttAccelerator);
      this.pttAccelerator = undefined;
      this.pushToTalkRegistered = false;
    }
    this.syncShortcuts();
  }

  /** Wait for every queued interaction to settle. */
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
    if (this.chatAccelerator !== undefined) this.platform.shortcuts.unregister(this.chatAccelerator);
    if (this.pttAccelerator !== undefined) this.platform.shortcuts.unregister(this.pttAccelerator);
    this.chatAccelerator = undefined;
    this.pttAccelerator = undefined;
    this.chatShortcutRegistered = false;
    this.pushToTalkRegistered = false;
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

  /**
   * The global accelerator is the supreme toggle: the OS reports the key going
   * down and never its release, so a hold gesture is impossible through it.
   * The voice controller owns the mode semantics — a tap is a `press`, and in
   * toggle mode the controller finalizes on the next press. Only in hold mode,
   * where a lone press would otherwise capture forever, does the shell pair the
   * press with a release on the next tap. Hold-to-talk lives on the focused
   * `F5` key, which does report a release.
   */
  private async activatePushToTalk(): Promise<void> {
    if (!this.pushToTalkEnabled()) return;
    const mode = this.settings.load().pushToTalkMode;
    if (mode !== this.pttAcceleratorMode) {
      // A mode change mid-gesture would otherwise pair a toggle press with a
      // hold release (or vice versa); reset the local pairing state first.
      this.pttAcceleratorMode = mode;
      this.pttToggled = false;
    }
    if (mode === 'toggle') {
      this.applyRouting(await this.interaction.handle({ kind: 'push_to_talk_press' }));
      return;
    }
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
      if (!this.pushToTalkEnabled()) return;
      this.pttHeld = true;
      this.applyRouting(await this.interaction.handle({ kind: 'push_to_talk_press' }));
      return;
    }
    if (!this.pttHeld) return;
    this.pttHeld = false;
    await this.interaction.handle({ kind: 'push_to_talk_release' });
  }

  /**
   * Whether a push-to-talk gesture may capture now. Both the saved setting and
   * an injected gate are consulted; either can refuse. A disabled control
   * refuses locally before any device is opened.
   */
  private pushToTalkEnabled(): boolean {
    if (!this.settings.load().pushToTalkEnabled) return false;
    return this.pttAllowed === undefined || this.pttAllowed();
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
    let handle = this.windows.get(kind);
    if (handle === undefined || handle.isDestroyed()) {
      // A closed window leaves a destroyed handle; rebuild rather than act on it.
      if (handle?.isDestroyed()) this.windows.delete(kind);
      handle = this.createWindow(kind);
    }
    if (kind === 'orb') {
      handle.setBounds(placeOrb(this.platform.screen.primary().workArea, sizeFor(kind), ORB_DIAMETER));
    }
    handle.show();
    // The Orb is a presence: borderless, always-on-top and click-through. It is
    // never focused, because taking focus would steal it from whatever the user
    // was doing when the capture activation fired.
    if (kind !== 'orb' && handle.visible) handle.focus();
    if (kind === 'orb') this.showBackdrop();
    if (persist) this.persistOpenWindows();
    return handle;
  }

  hide(kind: WindowKind): void {
    const handle = this.windows.get(kind);
    if (handle !== undefined && !handle.isDestroyed()) handle.hide();
    if (kind === 'orb') this.hideBackdrop();
    this.persistOpenWindows();
  }

  /** Drop a window handle the platform reports as closed. */
  forgetWindow(kind: WindowKind): void {
    this.windows.delete(kind);
    if (kind === 'orb_backdrop') this.backdropOpen = false;
    this.persistOpenWindows();
  }

  /**
   * Ensure the hidden voice window exists and is loading. The renderer it hosts
   * owns the microphone; the shell never shows it. Called before any capture
   * command so the window is ready to receive `start`.
   */
  ensureVoiceWindow(): void {
    let handle = this.windows.get('voice');
    if (handle === undefined || handle.isDestroyed()) {
      if (handle?.isDestroyed()) this.windows.delete('voice');
      handle = this.createWindow('voice', { startHidden: true, focusable: false, skipTaskbar: true });
    }
    handle.load();
  }

  /** Push a message to the hidden voice renderer. */
  sendToVoice(channel: string, ...args: readonly unknown[]): void {
    const handle = this.windows.get('voice');
    if (handle === undefined || handle.isDestroyed()) return;
    handle.send(channel, ...args);
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
            bounds: placeOrb(this.platform.screen.primary().workArea, sizeFor(kind), ORB_DIAMETER),
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
