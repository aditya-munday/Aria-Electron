import { describe, expect, it } from 'vitest';

import {
  ALLOWED_PERMISSIONS,
  applySessionHardening,
  applyWebContentsHardening,
  clearSessionStorage,
  hardenedWebPreferences,
  isAppUrl,
  isPermissionAllowed,
  isTrustedSender,
  REMOTE_REQUEST_FILTER,
  REMOTE_SCHEMES,
  RENDERER_WEB_PREFERENCES,
  type HardenedSession,
  type HardenedWebContents,
  type NavigationEvent,
  type PermissionDetails,
} from './security.js';

type NavigateListener = (event: NavigationEvent, url: string) => void;
type WebviewListener = (event: NavigationEvent) => void;

/** A recording double for the exact WebContents surface the policy drives. */
class FakeWebContents implements HardenedWebContents {
  readonly navigate: NavigateListener[] = [];
  readonly redirect: NavigateListener[] = [];
  readonly attachWebview: WebviewListener[] = [];
  readonly windowOpen: ((details: { readonly url: string }) => { action: 'deny' })[] = [];

  on(event: string, listener: NavigateListener | WebviewListener): unknown {
    if (event === 'will-navigate') this.navigate.push(listener as NavigateListener);
    else if (event === 'will-redirect') this.redirect.push(listener as NavigateListener);
    else this.attachWebview.push(listener as WebviewListener);
    return this;
  }

  setWindowOpenHandler(handler: (details: { readonly url: string }) => { action: 'deny' }): unknown {
    this.windowOpen.push(handler);
    return this;
  }

  prevented(url: string, kind: 'navigate' | 'redirect' = 'navigate'): boolean {
    let didPrevent = false;
    const event: NavigationEvent = {
      preventDefault: () => {
        didPrevent = true;
      },
    };
    const handlers = kind === 'navigate' ? this.navigate : this.redirect;
    for (const handler of handlers) handler(event, url);
    return didPrevent;
  }

  webviewPrevented(): boolean {
    let didPrevent = false;
    const event: NavigationEvent = {
      preventDefault: () => {
        didPrevent = true;
      },
    };
    for (const handler of this.attachWebview) handler(event);
    return didPrevent;
  }
}

/** A recording double for the exact Session surface the policy drives. */
class FakeSession implements HardenedSession {
  requestFilter: { readonly urls: readonly string[] } | undefined;
  beforeRequest:
    | ((
        details: { readonly url: string; readonly resourceType?: string },
        callback: (response: { readonly cancel: boolean }) => void,
      ) => void)
    | undefined;
  requestHandler:
    | ((c: unknown, p: string, cb: (g: boolean) => void, d: PermissionDetails) => void)
    | undefined;
  checkHandler: ((c: unknown, p: string, origin: string, d: PermissionDetails) => boolean) | undefined;
  deviceHandler: ((details: { readonly deviceType: string }) => boolean) | undefined;
  displayHandler: ((request: unknown, callback: (streams: unknown) => void) => void) | undefined;
  cleared = false;

  readonly webRequest = {
    onBeforeRequest: (
      filter: { readonly urls: readonly string[] },
      listener: (
        details: { readonly url: string; readonly resourceType?: string },
        callback: (response: { readonly cancel: boolean }) => void,
      ) => void,
    ): void => {
      this.requestFilter = filter;
      this.beforeRequest = listener;
    },
  };

  setPermissionRequestHandler(
    handler: (c: unknown, p: string, cb: (g: boolean) => void, d: PermissionDetails) => void,
  ): void {
    this.requestHandler = handler;
  }

  setPermissionCheckHandler(
    handler: (c: unknown, p: string, origin: string, d: PermissionDetails) => boolean,
  ): void {
    this.checkHandler = handler;
  }

  setDevicePermissionHandler(handler: unknown): void {
    this.deviceHandler = handler as (details: { readonly deviceType: string }) => boolean;
  }

  setDisplayMediaRequestHandler(handler: unknown): void {
    this.displayHandler = handler as (
      request: unknown,
      callback: (streams: unknown) => void,
    ) => void;
  }

  clearStorageData(): Promise<void> {
    this.cleared = true;
    return Promise.resolve();
  }

  requestGranted(permission: string, details: PermissionDetails): boolean {
    let granted = false;
    this.requestHandler?.({}, permission, (g) => (granted = g), details);
    return granted;
  }

  checkGranted(permission: string, origin: string): boolean {
    return this.checkHandler?.({}, permission, origin, {}) ?? false;
  }

  requestCancelled(url: string): boolean {
    let cancelled = false;
    this.beforeRequest?.({ url }, (response) => {
      cancelled = response.cancel;
    });
    return cancelled;
  }
}

function hardened(): FakeWebContents {
  const contents = new FakeWebContents();
  applyWebContentsHardening(contents);
  return contents;
}

function hardenedSession(): FakeSession {
  const session = new FakeSession();
  applySessionHardening(session);
  return session;
}

describe('renderer web preferences', () => {
  it('isolates the renderer and disables node in every form', () => {
    expect(RENDERER_WEB_PREFERENCES.contextIsolation).toBe(true);
    expect(RENDERER_WEB_PREFERENCES.nodeIntegration).toBe(false);
    expect(RENDERER_WEB_PREFERENCES.nodeIntegrationInWorker).toBe(false);
    expect(RENDERER_WEB_PREFERENCES.nodeIntegrationInSubFrames).toBe(false);
  });

  it('sandboxes the renderer and keeps web security on', () => {
    expect(RENDERER_WEB_PREFERENCES.sandbox).toBe(true);
    expect(RENDERER_WEB_PREFERENCES.webSecurity).toBe(true);
    expect(RENDERER_WEB_PREFERENCES.allowRunningInsecureContent).toBe(false);
  });

  it('removes the remote-content and debugging affordances', () => {
    expect(RENDERER_WEB_PREFERENCES.webviewTag).toBe(false);
    expect(RENDERER_WEB_PREFERENCES.devTools).toBe(false);
    expect(RENDERER_WEB_PREFERENCES.experimentalFeatures).toBe(false);
    expect(RENDERER_WEB_PREFERENCES.safeDialogs).toBe(true);
  });

  it('attaches the preload without dropping any hardening', () => {
    const prefs = hardenedWebPreferences('/opt/Aria/preload.cjs');
    expect(prefs.preload).toBe('/opt/Aria/preload.cjs');
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.sandbox).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
  });
});

describe('permission policy', () => {
  it('allows only the microphone', () => {
    expect(isPermissionAllowed('media')).toBe(true);
    expect(isPermissionAllowed('audioCapture')).toBe(true);
    expect(ALLOWED_PERMISSIONS).toHaveLength(2);
    for (const denied of ['notifications', 'geolocation', 'clipboard-read', 'openExternal', 'midi']) {
      expect(isPermissionAllowed(denied)).toBe(false);
    }
  });
});

describe('url classification', () => {
  it('only treats local file pages as app urls', () => {
    expect(isAppUrl('file:///opt/Aria/resources/app.asar/dist/renderer/chat.html')).toBe(true);
    expect(isAppUrl('https://evil.example')).toBe(false);
    expect(isAppUrl('data:text/html,<script>1</script>')).toBe(false);
    expect(isAppUrl('javascript:alert(1)')).toBe(false);
  });

  it('trusts an ipc sender only from an app frame', () => {
    expect(isTrustedSender({ senderFrame: { url: 'file:///app/chat.html' } })).toBe(true);
    expect(isTrustedSender({ senderFrame: { url: 'https://evil.example' } })).toBe(false);
    expect(isTrustedSender({ senderFrame: { url: '' } })).toBe(false);
    expect(isTrustedSender({ senderFrame: null })).toBe(false);
    expect(isTrustedSender({})).toBe(false);
  });
});

describe('navigation and popups', () => {
  it('cancels any navigation away from an app page', () => {
    const contents = hardened();
    expect(contents.prevented('https://evil.example')).toBe(true);
    expect(contents.prevented('data:text/html,1')).toBe(true);
    expect(contents.prevented('file:///opt/Aria/resources/app.asar/dist/renderer/chat.html')).toBe(false);
  });

  it('cancels a cross-origin redirect', () => {
    const contents = hardened();
    expect(contents.prevented('https://evil.example', 'redirect')).toBe(true);
    expect(contents.prevented('file:///app/chat.html', 'redirect')).toBe(false);
  });

  it('denies every popup, even to an app page', () => {
    const contents = hardened();
    expect(contents.windowOpen).toHaveLength(1);
    expect(contents.windowOpen[0]?.({ url: 'https://evil.example' })).toEqual({ action: 'deny' });
    expect(contents.windowOpen[0]?.({ url: 'file:///app/chat.html' })).toEqual({ action: 'deny' });
  });

  it('denies a webview attach', () => {
    expect(hardened().webviewPrevented()).toBe(true);
  });
});

describe('permission handlers', () => {
  it('grants the microphone only to a main frame on an app page', () => {
    const session = hardenedSession();
    expect(
      session.requestGranted('media', { isMainFrame: true, requestingUrl: 'file:///app/chat.html' }),
    ).toBe(true);
    expect(
      session.requestGranted('media', { isMainFrame: true, requestingUrl: 'https://evil.example/' }),
    ).toBe(false);
    expect(
      session.requestGranted('media', { isMainFrame: false, requestingUrl: 'file:///app/chat.html' }),
    ).toBe(false);
  });

  it('denies every non-microphone permission request', () => {
    const session = hardenedSession();
    expect(session.requestGranted('notifications', { isMainFrame: true })).toBe(false);
    expect(session.requestGranted('geolocation', { isMainFrame: true })).toBe(false);
    expect(session.requestGranted('clipboard-read', { isMainFrame: true })).toBe(false);
  });

  it('denies a microphone check from a non-app origin', () => {
    const session = hardenedSession();
    expect(session.checkGranted('media', 'file:///app/orb.html')).toBe(true);
    expect(session.checkGranted('media', 'https://evil.example')).toBe(false);
    expect(session.checkGranted('geolocation', 'file:///app/orb.html')).toBe(false);
  });

  it('denies device and screen-capture access outright', () => {
    const session = hardenedSession();
    expect(session.deviceHandler?.({ deviceType: 'hid' })).toBe(false);
    expect(session.deviceHandler?.({ deviceType: 'usb' })).toBe(false);
    let streams: unknown = 'unset';
    session.displayHandler?.({}, (value) => (streams = value));
    expect(streams).toEqual({});
  });
});

describe('renderer network lockdown', () => {
  it('cancels every remote request a renderer makes', () => {
    const session = hardenedSession();
    expect(REMOTE_SCHEMES).toContain('https');
    expect(REMOTE_REQUEST_FILTER.urls).toContain('https://*/*');
    expect(REMOTE_REQUEST_FILTER.urls).toContain('ws://*/*');
    expect(session.requestCancelled('https://api.adityamunday.codes/v1/tasks')).toBe(true);
    expect(session.requestCancelled('ws://evil.example/socket')).toBe(true);
  });

  it('clears session storage on demand', async () => {
    const session = hardenedSession();
    expect(session.cleared).toBe(false);
    await clearSessionStorage(session);
    expect(session.cleared).toBe(true);
  });

  it('tolerates a session without optional handlers', async () => {
    const minimal: HardenedSession = {
      webRequest: { onBeforeRequest: () => undefined },
      setPermissionRequestHandler: () => undefined,
      setPermissionCheckHandler: () => undefined,
    };
    expect(() => applySessionHardening(minimal)).not.toThrow();
    await expect(clearSessionStorage(minimal)).resolves.toBeUndefined();
  });
});
