import { describe, expect, it } from 'vitest';

import { blockExternalNavigation, RENDERER_WEB_PREFERENCES } from './security.js';

describe('renderer security posture', () => {
  it('isolates the renderer context from node', () => {
    expect(RENDERER_WEB_PREFERENCES.contextIsolation).toBe(true);
    expect(RENDERER_WEB_PREFERENCES.nodeIntegration).toBe(false);
  });

  it('enables web security', () => {
    expect(RENDERER_WEB_PREFERENCES.webSecurity).toBe(true);
  });

  it('denies navigation away from the app', () => {
    const navigations: ((url: string) => { action: 'deny' })[] = [];
    const popups: ((url: string) => { action: 'deny' })[] = [];
    blockExternalNavigation({
      willNavigate: (handler) => navigations.push(handler),
      setWindowOpenHandler: (handler) => popups.push(handler),
    });
    expect(navigations).toHaveLength(1);
    expect(popups).toHaveLength(1);
    expect(navigations[0]?.('https://evil.example')).toEqual({ action: 'deny' });
    expect(popups[0]?.('https://evil.example')).toEqual({ action: 'deny' });
  });
});
