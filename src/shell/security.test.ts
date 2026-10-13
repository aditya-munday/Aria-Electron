import { describe, expect, it } from 'vitest';

import {
  ALLOWED_PERMISSIONS,
  applyWebContentsHardening,
  hardenedWebPreferences,
  isAppUrl,
  isPermissionAllowed,
  isTrustedSender,
  RENDERER_WEB_PREFERENCES,
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
  requestHandler:
    | ((c: unknown, p: string, cb: (g: boolean) => void, d: PermissionDetails) => void)
    | undefined;
  checkHandler: ((c: unknown, p: string, origin: string, d: PermissionDetails) => boolean) | undefined;

  readonly session = {
    setPermissionRequestHandler: (
      handler: (c: unknown, p: string, cb: (g: boolean) => void, d: PermissionDetails) => void,
    ): void => {
      this.requestHandler = handler;
    },
    setPermissionCheckHandler: (
      handler: (c: unknown, p: string, origin: string, d: PermissionDetails) => boolean,
    ): void => {
      this.checkHandler = handler;
    },
  };

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

  requestGranted(permission: string, details: PermissionDetails): boolean {
    let granted = false;
    this.requestHandler?.({}, permission, (g) => (granted = g), details);
    return granted;
  }

  checkGranted(permission: string, origin: string): boolean {
    return this.checkHandler?.({}, permission, origin, {}) ?? false;
  }
}

function hardened(): FakeWebContents {
  const contents = new FakeWebContents();
  applyWebContentsHardening(contents);
  return contents;
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
    const contents = hardened();
    expect(
      contents.requestGranted('media', { isMainFrame: true, requestingUrl: 'file:///app/chat.html' }),
    ).toBe(true);
    expect(
      contents.requestGranted('media', { isMainFrame: true, requestingUrl: 'https://evil.example/' }),
    ).toBe(false);
    expect(
      contents.requestGranted('media', { isMainFrame: false, requestingUrl: 'file:///app/chat.html' }),
    ).toBe(false);
  });

  it('denies every non-microphone permission request', () => {
    const contents = hardened();
    expect(contents.requestGranted('notifications', { isMainFrame: true })).toBe(false);
    expect(contents.requestGranted('geolocation', { isMainFrame: true })).toBe(false);
    expect(contents.requestGranted('clipboard-read', { isMainFrame: true })).toBe(false);
  });

  it('denies a microphone check from a non-app origin', () => {
    const contents = hardened();
    expect(contents.checkGranted('media', 'file:///app/orb.html')).toBe(true);
    expect(contents.checkGranted('media', 'https://evil.example')).toBe(false);
    expect(contents.checkGranted('geolocation', 'file:///app/orb.html')).toBe(false);
  });
});
