/**
 * The renderer hardening policy, in one place.
 *
 * Aria loads only its own local pages from a privileged `app://` scheme, but a
 * desktop shell is a privileged process: the renderer must be treated as
 * untrusted regardless. Every window is created with the preferences below and
 * every webContents is wired through {@link applyWebContentsHardening}, so
 * navigation, popups, permissions, webviews and devtools are all denied at the
 * process boundary rather than left to the renderer's own discipline.
 */

import { readFileSync, statSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';

/** The scheme the app's own renderer pages are served from. */
export const APP_SCHEME = 'app';

/** The single host the app scheme answers on; any other host is not an app page. */
export const APP_HOST = 'aria';

/** The origin every app renderer page shares. */
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/** The `app://aria/<file>` URL for a renderer page. */
export function appPageUrl(file: string): string {
  return `${APP_ORIGIN}/${file}`;
}

export interface AppProtocolRequest {
  readonly url: string;
}

export interface AppProtocolHost {
  registerSchemesAsPrivileged(schemes: readonly unknown[]): void;
  handle(scheme: string, handler: (request: AppProtocolRequest) => Response | Promise<Response>): void;
}

/** The scheme privileges a secure, fetch-capable, standard app scheme needs. */
export const APP_SCHEME_PRIVILEGES: readonly {
  readonly scheme: string;
  readonly privileges: Readonly<Record<string, boolean>>;
}[] = [
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true,
    },
  },
];

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  return (dot >= 0 ? CONTENT_TYPES[path.slice(dot).toLowerCase()] : undefined) ?? 'application/octet-stream';
}

function notFound(): Response {
  return new Response(null, { status: 404 });
}

/**
 * Resolve an `app://aria/<file>` request to a file inside `rendererRoot`.
 *
 * The URL is re-parsed and only the pathname is used, so a host other than
 * `aria` (e.g. `app://evil/…`) or a traversal (`../`) resolves outside the root
 * and is rejected. `normalize` collapses `..` before the prefix check, and the
 * `root + sep` guard stops a sibling like `/root-evil` from passing.
 */
export function resolveAppAsset(rendererRoot: string, rawUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== `${APP_SCHEME}:` || parsed.hostname !== APP_HOST) return undefined;
  const decoded = decodeURIComponent(parsed.pathname);
  if (decoded.includes('\0')) return undefined;
  const root = normalize(rendererRoot);
  const target = normalize(join(root, decoded));
  if (target !== root && !target.startsWith(root + sep)) return undefined;
  return target;
}

/**
 * Declare the privileged app scheme. Must run before the app is ready.
 */
export function registerAppSchemePrivileges(host: AppProtocolHost): void {
  host.registerSchemesAsPrivileged(APP_SCHEME_PRIVILEGES);
}

/**
 * Serve the renderer directory from the app scheme. Runs once the app is ready,
 * so the pages load from `app://aria/…` instead of `file://` and the
 * `grantFileProtocolExtraPrivileges` fuse can stay off.
 */
export function serveAppScheme(host: AppProtocolHost, rendererRoot: string): void {
  host.handle(APP_SCHEME, async (request) => {
    const target = resolveAppAsset(rendererRoot, request.url);
    if (target === undefined) return notFound();
    try {
      const stat = statSync(target);
      if (!stat.isFile()) return notFound();
      const body = readFileSync(target);
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': contentTypeFor(target),
          'content-length': String(stat.size),
        },
      });
    } catch {
      return notFound();
    }
  });
}

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

/** Whether a URL is one of the app's own pages, served from the `app://` origin. */
export function isAppUrl(url: string): boolean {
  return url === APP_ORIGIN || url.startsWith(`${APP_ORIGIN}/`);
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
}

/**
 * The slice of Electron's `Session` the policy drives. Permission handlers and
 * the request filter live on the session, not the window, so they are applied
 * once to the app's session rather than per webContents.
 */
export interface HardenedSession {
  readonly webRequest: {
    onBeforeRequest(
      filter: { readonly urls: readonly string[] },
      listener: (
        details: { readonly url: string; readonly resourceType?: string },
        callback: (response: { readonly cancel: boolean }) => void,
      ) => void,
    ): void;
  };
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
  /**
   * The optional handlers are typed loosely on purpose: Electron gives each a
   * concrete request/callback shape, and a stricter signature here would make
   * the real `Session` fail to satisfy this interface. The policy never reads the
   * argument, so `unknown` is the honest type.
   */
  setDevicePermissionHandler?(handler: unknown): void;
  setDisplayMediaRequestHandler?(handler: unknown): void;
  clearStorageData?(): Promise<void>;
}

/** The schemes a renderer must never reach: the main process owns the network. */
export const REMOTE_SCHEMES: readonly string[] = ['http', 'https', 'ws', 'wss', 'ftp'];

/** The `onBeforeRequest` filter that matches every remote request. */
export const REMOTE_REQUEST_FILTER: { readonly urls: readonly string[] } = {
  urls: REMOTE_SCHEMES.map((scheme) => `${scheme}://*/*`),
};

/**
 * Apply the whole navigation/popup/webview policy to one webContents.
 *
 * - Any navigation away from the app's own `app://` pages is cancelled.
 * - Any popup is denied, with no shell fallback.
 * - A `<webview>` is denied outright: Aria embeds no remote content.
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
}

/**
 * Apply the session-scoped policy to the app's session.
 *
 * - Every remote request a renderer makes is cancelled. The renderer is a local
 *   page with no network business; the backend is reached from the main process,
 *   whose Node `fetch` does not use this filter.
 * - Only the microphone permission is granted, and only to a main frame that is
 *   itself an app page; every other request and synchronous check is denied.
 * - Device (HID/serial/USB) and screen-capture access are denied outright.
 */
export function applySessionHardening(session: HardenedSession): void {
  session.webRequest.onBeforeRequest(REMOTE_REQUEST_FILTER, (_details, callback) => {
    callback({ cancel: true });
  });
  session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const mainFrame = details.isMainFrame !== false;
    const fromApp = details.requestingUrl === undefined || isAppUrl(details.requestingUrl);
    callback(mainFrame && fromApp && isPermissionAllowed(permission));
  });
  session.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    const fromApp = requestingOrigin === '' || isAppUrl(requestingOrigin);
    return fromApp && isPermissionAllowed(permission);
  });
  session.setDevicePermissionHandler?.((() => false) as unknown);
  session.setDisplayMediaRequestHandler?.(
    ((_request: unknown, callback: (streams: unknown) => void) => callback({})) as unknown,
  );
}

/** Drop every cookie, cache and storage record the session accumulated. */
export function clearSessionStorage(session: HardenedSession): Promise<void> {
  return session.clearStorageData?.() ?? Promise.resolve();
}
