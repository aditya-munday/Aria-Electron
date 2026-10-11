// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { renderControlCenter, type ControlCenterBridge } from './control-center.js';
import type { ControlCenterState } from '../state.js';

function state(overrides: Partial<ControlCenterState> = {}): ControlCenterState {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    account: { state: 'signed_out' },
    voice: {
      catalogState: 'available',
      speakResponses: true,
      voices: [{ id: 'v1', name: 'Aria', language: 'en-US' }],
    },
    activation: {
      pushToTalk: { enabled: true, mode: 'hold', key: 'Hold ?' },
      wakeWord: { enabled: false, phrase: 'hey aria', available: true },
      chatShortcut: { enabled: true, accelerator: 'CommandOrControl+Alt+A' },
    },
    ariaConfig: {
      backendBaseUrl: 'http://127.0.0.1:8080',
      requestTimeoutMs: 30000,
      options: [],
    },
    privacy: {
      tokenStored: 'memory_only',
      historyRetention: 'opted_out',
      historyRetentionEditable: false,
      notes: [],
    },
    integrations: { backend: { state: 'ok' }, aiEngineer: { state: 'unknown' } },
    diagnostics: { backendState: 'ok', voiceReady: true, listening: false, checkedAt: 'now' },
    tasks: [],
    ...overrides,
  };
}

function bridge(stateValue: ControlCenterState): { bridge: ControlCenterBridge; patches: unknown[] } {
  const patches: unknown[] = [];
  return {
    patches,
    bridge: {
      controlCenterState: async () => stateValue,
      updateSettings: async (patch) => {
        patches.push(patch);
        return { ok: true };
      },
      signIn: async () => ({ ok: false, reason: 'unsupported', unsupported: true }),
      signOut: async () => ({ ok: true }),
    },
  };
}

function render(value: ControlCenterState) {
  document.body.innerHTML = '<main id="control-center"></main>';
  const { bridge: b, patches } = bridge(value);
  renderControlCenter(document, value, b);
  return { patches };
}

describe('control center renderer', () => {
  it('renders a signed-out profile with a working sign-in control', () => {
    render(state());
    expect(document.getElementById('account-sign-in')).not.toBeNull();
    expect(document.getElementById('account-sign-out')).toBeNull();
  });

  it('renders the signed-in identity rather than a placeholder', () => {
    render(
      state({
        account: {
          state: 'signed_in',
          userId: 'u-42',
          email: 'ada@example.com',
          roles: ['owner'],
          providers: ['password'],
          anonymous: false,
        },
      }),
    );
    expect(document.body.textContent).toContain('u-42');
    expect(document.body.textContent).toContain('ada@example.com');
    expect(document.getElementById('account-sign-out')).not.toBeNull();
  });

  it('enables the voice selector when the catalog is available', () => {
    render(state());
    const select = document.getElementById('voice-select') as HTMLSelectElement | null;
    expect(select?.disabled).toBe(false);
  });

  it('disables the voice selector with an honest reason when the catalog is unavailable', () => {
    render(
      state({
        voice: {
          catalogState: 'unknown',
          speakResponses: true,
          voices: [],
          reason: 'Connection refused.',
        },
      }),
    );
    const select = document.getElementById('voice-select') as HTMLSelectElement | null;
    expect(select?.disabled).toBe(true);
    expect(document.body.textContent).toContain('Connection refused.');
  });

  it('disables the wake-word control when the engine is unavailable and shows why', () => {
    render(
      state({
        activation: {
          pushToTalk: { enabled: true, mode: 'hold', key: 'Hold ?' },
          wakeWord: {
            enabled: false,
            phrase: 'hey aria',
            available: false,
            reason: 'The wake-word engine is unavailable on this build.',
          },
          chatShortcut: { enabled: true, accelerator: 'CommandOrControl+Alt+A' },
        },
      }),
    );
    const toggle = document.getElementById('wake-word-enabled') as HTMLInputElement | null;
    expect(toggle?.disabled).toBe(true);
    expect(document.body.textContent).toContain('wake-word engine is unavailable');
  });

  it('sends a settings patch when push-to-talk mode changes', () => {
    const { patches } = render(state());
    const select = document.getElementById('push-to-talk-mode') as HTMLSelectElement;
    select.value = 'toggle';
    select.dispatchEvent(new Event('change'));
    expect(patches).toContainEqual({ pushToTalkMode: 'toggle' });
  });

  it('sends a null to clear the voice when the backend default is chosen', () => {
    const { patches } = render(state());
    const select = document.getElementById('voice-select') as HTMLSelectElement;
    select.value = '';
    select.dispatchEvent(new Event('change'));
    expect(patches).toContainEqual({ voice: null });
  });

  it('sends a settings patch when a toggle changes', () => {
    const { patches } = render(state());
    const toggle = document.getElementById('speak-responses') as HTMLInputElement;
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    expect(patches).toContainEqual({ speakResponses: false });
  });

  it('shows an empty task history rather than inventing rows', () => {
    render(state());
    expect(document.body.textContent).toContain('No tasks yet.');
  });

  it('shows diagnostics and integration state from the sources', () => {
    render(
      state({
        integrations: {
          backend: { state: 'outage', reason: 'Connection refused.' },
          aiEngineer: { state: 'outage', reason: 'Unreachable while the Backend is unavailable.' },
        },
      }),
    );
    expect(document.body.textContent).toContain('outage');
    expect(document.body.textContent).toContain('Connection refused.');
  });
});
