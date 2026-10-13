/**
 * The renderer hardening policy, in one place.
 *
 * Aria loads only its own local pages, but a desktop shell is a privileged
 * process: the renderer must be treated as untrusted regardless. Every window is
 * created with the preferences below and every webContents is wired through
 * {@link applyWebContentsHardening}, so navigation, popups, permissions,
 * webviews and devtools are all denied at the process boundary rather than left
 * to the renderer's own discipline.
 */

export interface RendererWindowSecurity {
  readonly contextIsolation: true;
  readonly nodeIntegration: false;
  readonly sandbox: true;
  readonly webSecurity: true;
  readonly allowRunningInsecureContent: false;
  readonly experimentalFeatures: false;
  readonly webviewTag: false;
  readonly nodeIntegrationInWorker: false;
  readonly nodeIntegrationInSubFrames: false;
  readonly spellcheck: false;
  readonly devTools: false;
  readonly safeDialogs: true;
  /** Blink features with a history of renderer escape are switched off. */
  readonly disableBlinkFeatures: string;
}

export const RENDERER_WEB_PREFERENCES: RendererWindowSecurity = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  webviewTag: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  spellcheck: false,
  devTools: false,
  safeDialogs: true,
  disableBlinkFeatures: 'Auxclick',
};

export interface RendererWebPreferences extends RendererWindowSecurity {
  readonly preload: string;
}

/**
 * The full `webPreferences` for a renderer window. A preload is mandatory: it is
 * the only channel into the privileged process, and the bridge it exposes is
 * fixed at build time.
 */
export function hardenedWebPreferences(preload: string): RendererWebPreferences {
  return { ...RENDERER_WEB_PREFERENCES, preload };
}

/** The permissions the app can genuinely need. Everything else is denied. */
export const ALLOWED_PERMISSIONS: readonly string[] = ['media', 'audioCapture'];

/**
 * A hard allowlist, not a denylist: an unknown or future permission is denied by
 * default, and only the microphone is ever granted.
 */
export function isPermissionAllowed(permission: string): boolean {
  return ALLOWED_PERMISSIONS.includes(permission);
}

/** Whether a URL is one of the app's own local pages. */
export function isAppUrl(url: string): boolean {
  return url.startsWith('file://');
}

export interface IpcSenderEvent {
  readonly senderFrame?: { readonly url?: string } | null;
}

/**
 * Whether an IPC message came from one of the app's own renderer frames. A
 * privileged handler must never act on a message from a frame the app did not
 * load, so the sender URL is the gate.
 */
export function isTrustedSender(event: IpcSenderEvent): boolean {
  const url = event.senderFrame?.url;
  return typeof url === 'string' && url !== '' && isAppUrl(url);
}

export interface NavigationEvent {
  preventDefault(): void;
}

export interface PermissionDetails {
  readonly permission?: string;
  readonly isMainFrame?: boolean;
  readonly requestingUrl?: string;
}

/**
 * The slice of Electron's `WebContents` this module drives. It is structural so
 * the hardening can be exercised against a recording double, and so the same
 * policy applies to every window without the caller re-implementing it.
 *
 * `on` is deliberately loose: Electron declares one overload per event, and a
 * narrow interface cannot match them all, so the event name and listener are
 * passed through and the concrete listener types are asserted at the call site.
 */
export interface HardenedWebContents {
  on(event: string, listener: (...args: never[]) => void): unknown;
  setWindowOpenHandler(handler: (details: { readonly url: string }) => { action: 'deny' }): unknown;
  readonly session: {
    setPermissionRequestHandler(
      handler: (
        contents: unknown,
        permission: string,
        callback: (granted: boolean) => void,
        details: PermissionDetails,
      ) => void,
    ): void;
    setPermissionCheckHandler(
      handler: (
        contents: unknown,
        permission: string,
        requestingOrigin: string,
        details: PermissionDetails,
      ) => boolean,
    ): void;
  };
}

/**
 * Apply the whole navigation/permission policy to one webContents.
 *
 * - Any navigation away from the app's own `file://` pages is cancelled.
 * - Any popup is denied, with no shell fallback.
 * - A `<webview>` is denied outright: Aria embeds no remote content.
 * - Only the microphone permission is granted, and only to a main frame that is
 *   itself an app page; every other request and synchronous check is denied.
 */
export function applyWebContentsHardening(contents: HardenedWebContents): void {
  const denyNavigation = (event: NavigationEvent, url: string): void => {
    if (!isAppUrl(url)) event.preventDefault();
  };
  contents.on('will-navigate', denyNavigation as (...args: never[]) => void);
  contents.on('will-redirect', denyNavigation as (...args: never[]) => void);
  contents.on('will-attach-webview', ((event: NavigationEvent) => {
    event.preventDefault();
  }) as (...args: never[]) => void);
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const mainFrame = details.isMainFrame !== false;
    const fromApp = details.requestingUrl === undefined || isAppUrl(details.requestingUrl);
    callback(mainFrame && fromApp && isPermissionAllowed(permission));
  });
  contents.session.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    const fromApp = requestingOrigin === '' || isAppUrl(requestingOrigin);
    return fromApp && isPermissionAllowed(permission);
  });
}
