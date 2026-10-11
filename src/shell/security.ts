export interface RendererWindowSecurity {
  readonly contextIsolation: true;
  readonly nodeIntegration: false;
  readonly sandbox: false;
  readonly webSecurity: true;
}

export const RENDERER_WEB_PREFERENCES: RendererWindowSecurity = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: false,
  webSecurity: true,
};

export interface ExternalNavigationGuard {
  willNavigate(handler: (url: string) => { action: 'deny' }): void;
  setWindowOpenHandler(handler: (url: string) => { action: 'deny' }): void;
}

export function blockExternalNavigation(window: ExternalNavigationGuard): void {
  window.willNavigate(() => ({ action: 'deny' }));
  window.setWindowOpenHandler(() => ({ action: 'deny' }));
}
