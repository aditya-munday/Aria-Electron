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
      speechRate: 1,
      languages: [
        { tag: 'en-US', name: 'English (United States)' },
        { tag: 'en-GB', name: 'English (United Kingdom)' },
      ],
      sttLanguages: ['en-US', 'en-GB'],
      voices: [
        {
          id: 'v1',
          name: 'Aria',
          language: 'en-US',
          accent: 'en-us',
          gender: 'female',
          styles: ['warm'],
        },
        {
          id: 'v2',
          name: 'Magnus',
          language: 'en-GB',
          accent: 'en-gb',
          gender: 'male',
          styles: ['calm', 'narration'],
          description: 'A measured British narrator.',
        },
      ],
    },
    activation: {
      pushToTalk: {
        enabled: true,
        mode: 'hold',
        key: 'Hold ?',
        globalAccelerator: 'Super+Alt+Space',
        globalRegistered: true,
      },
      wakeWord: { enabled: false, phrase: 'hey aria', available: true },
      chatShortcut: { enabled: true, accelerator: 'Super+Alt+A', registered: true },
    },
    ariaConfig: {
      backendBaseUrl: 'https://api.beyonders.dev',
      requestTimeoutMs: 30000,
      model: {
        provider: 'groq',
        id: 'groq/llama-3.3-70b-versatile',
        displayName: 'Llama 3.3 70B (Groq)',
        fixed: true,
      },
      options: [],
    },
    privacy: {
      tokenStored: 'memory_only',
      historyRetention: 'opted_out',
      historyRetentionEditable: false,
      notes: ['Session tokens are held in memory only.'],
    },
    integrations: {
      backend: { state: 'ok' },
      aiEngineer: { state: 'unknown' },
      catalogVersion: '1.0.0',
      capabilities: [
        {
          id: 'chat.typed_turn',
          title: 'Typed chat',
          summary: 'Send a typed turn.',
          privilege: 'none',
          approval: 'never',
          risk: 'low',
          sideEffects: [],
          verification: 'authoritative_result',
          cancellable: true,
          retry: 'idempotent',
          reversible: false,
          recovery: 'Reported as unknown and reconciled.',
          supported: true,
        },
        {
          id: 'voice.wake_word',
          title: 'Wake word',
          summary: 'Detect the wake phrase.',
          privilege: 'none',
          approval: 'never',
          risk: 'low',
          sideEffects: [],
          verification: 'local_observation',
          cancellable: true,
          retry: 'not_retryable',
          reversible: false,
          recovery: 'Unavailable detector is shown; push to talk still works.',
          supported: false,
          reason: 'No wake-word detector is available on this build.',
        },
      ],
    },
    appearance: { accent: 'aurora', showOrb: true, startOnLogin: false },
    diagnostics: {
      backendState: 'ok',
      voiceReady: true,
      voiceEngine: 'native',
      listening: false,
      checkedAt: 'now',
      incidents: [],
    },
    tasks: [],
    ...overrides,
  };
}

function bridge(stateValue: ControlCenterState): {
  bridge: ControlCenterBridge;
  patches: unknown[];
  signIns: unknown[];
  previews: unknown[];
} {
  const patches: unknown[] = [];
  const signIns: unknown[] = [];
  const previews: unknown[] = [];
  return {
    patches,
    signIns,
    previews,
    bridge: {
      controlCenterState: async () => stateValue,
      updateSettings: async (patch) => {
        patches.push(patch);
        return { ok: true };
      },
      previewVoice: async (input) => {
        previews.push(input);
        return { ok: true };
      },
      signIn: async (input) => {
        signIns.push(input);
        return { ok: false, signedIn: false, reason: 'The session token was rejected.' };
      },
      signOut: async () => ({ ok: true, signedIn: true }),
      openChat: async () => undefined,
    },
  };
}

function mount(): void {
  document.body.innerHTML = `
    <main id="control-center" class="app">
      <nav class="sidebar"></nav>
      <div class="content">
        <header class="topbar"></header>
        <div class="panels"></div>
      </div>
    </main>`;
}

function render(
  value: ControlCenterState,
  tab:
    | 'profile'
    | 'account'
    | 'voice'
    | 'activation'
    | 'ariaConfig'
    | 'privacy'
    | 'integrations'
    | 'tasks'
    | 'diagnostics'
    | 'general' = 'profile',
) {
  mount();
  const { bridge: b, patches, signIns, previews } = bridge(value);
  renderControlCenter(document, value, b, tab);
  return { patches, signIns, previews };
}

describe('control center renderer', () => {
  it('renders every section as a tab', () => {
    render(state());
    for (const id of [
      'profile',
      'account',
      'voice',
      'activation',
      'ariaConfig',
      'privacy',
      'integrations',
      'tasks',
      'diagnostics',
      'general',
    ]) {
      expect(document.getElementById(`tab-${id}`)).not.toBeNull();
      expect(document.getElementById(`panel-${id}`)).not.toBeNull();
    }
  });

  it('marks exactly the active tab as selected', () => {
    render(state(), 'voice');
    expect(document.getElementById('tab-voice')?.getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById('tab-profile')?.getAttribute('aria-selected')).toBe('false');
    expect(document.getElementById('panel-voice')?.getAttribute('data-active')).toBe('true');
  });

  it('shows the backend URL nowhere in the interface', () => {
    render(state());
    expect(document.body.textContent).not.toContain('api.beyonders.dev');
  });

  it('renders a sign-in form with email and token fields when signed out', () => {
    render(state(), 'account');
    expect(document.getElementById('account-email')).not.toBeNull();
    expect(document.getElementById('account-token')).not.toBeNull();
    expect(document.getElementById('account-sign-in')).not.toBeNull();
    expect(document.getElementById('account-sign-out')).toBeNull();
  });

  it('submits the entered token when signing in', () => {
    const { signIns } = render(state(), 'account');
    const token = document.getElementById('account-token') as HTMLInputElement;
    const email = document.getElementById('account-email') as HTMLInputElement;
    token.value = 'tok-123';
    email.value = 'ada@example.com';
    const form = token.closest('form');
    form?.dispatchEvent(new Event('submit'));
    expect(signIns).toContainEqual({ token: 'tok-123', email: 'ada@example.com' });
  });

  it('refuses to submit an empty token and says why', () => {
    const { signIns } = render(state(), 'account');
    const token = document.getElementById('account-token') as HTMLInputElement;
    token.closest('form')?.dispatchEvent(new Event('submit'));
    expect(signIns).toHaveLength(0);
    expect(document.body.textContent).toContain('Enter your session token');
  });

  it('renders the signed-in identity with a sign-out control', () => {
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
      'account',
    );
    expect(document.body.textContent).toContain('ada@example.com');
    expect(document.body.textContent).toContain('u-42');
    expect(document.getElementById('account-sign-out')).not.toBeNull();
    expect(document.getElementById('account-sign-in')).toBeNull();
  });

  it('offers a retry rather than a sign-in form when the account state is unknown', () => {
    render(state({ account: { state: 'unknown', reason: 'Connection refused.' } }), 'account');
    expect(document.getElementById('account-retry')).not.toBeNull();
    expect(document.getElementById('account-sign-in')).toBeNull();
    expect(document.body.textContent).toContain('Connection refused.');
  });

  it('renders the voice studio with one card per advertised voice', () => {
    render(state(), 'voice');
    const cards = document.querySelectorAll('.voice-card');
    expect(cards.length).toBe(2);
    expect(document.body.textContent).toContain('Aria');
    expect(document.body.textContent).toContain('Magnus');
  });

  it('filters the voice grid by the search query', () => {
    render(state(), 'voice');
    const search = document.querySelector('.studio-search') as HTMLInputElement;
    search.value = 'magnus';
    search.dispatchEvent(new Event('input'));
    expect(document.querySelectorAll('.voice-card').length).toBe(1);
    expect(document.body.textContent).toContain('Magnus');
  });

  it('filters the voice grid by gender', () => {
    render(state(), 'voice');
    const gender = document.querySelector('[data-facet="gender"]') as HTMLSelectElement;
    gender.value = 'female';
    gender.dispatchEvent(new Event('change'));
    expect(document.querySelectorAll('.voice-card').length).toBe(1);
    expect(document.body.textContent).toContain('Aria');
  });

  it('selects a voice and its language from a card', () => {
    const { patches } = render(state(), 'voice');
    const use = document.getElementById('use-v2') as HTMLButtonElement;
    use.click();
    expect(patches).toContainEqual({ voice: 'v2', language: 'en-GB' });
  });

  it('auditions a voice through the preview bridge', () => {
    const { previews } = render(state(), 'voice');
    const preview = document.getElementById('preview-v1') as HTMLButtonElement;
    preview.click();
    expect(previews).toContainEqual(
      expect.objectContaining({ voice: 'v1', speed: 1 }),
    );
  });

  it('sends a settings patch when the speech rate changes', () => {
    const { patches } = render(state(), 'voice');
    const slider = document.getElementById('rate-slider') as HTMLInputElement;
    slider.value = '1.5';
    slider.dispatchEvent(new Event('change'));
    expect(patches).toContainEqual({ speechRate: 1.5 });
  });

  it('reports an unreachable catalog honestly instead of inventing voices', () => {
    render(
      state({
        voice: {
          catalogState: 'unknown',
          speakResponses: true,
          speechRate: 1,
          languages: [],
          sttLanguages: [],
          voices: [],
          reason: 'Connection refused.',
        },
      }),
      'voice',
    );
    expect(document.querySelectorAll('.voice-card').length).toBe(0);
    expect(document.body.textContent).toContain('Connection refused.');
    expect(document.body.textContent).toContain('could not be reached');
  });

  it('disables the wake-word control when the engine is unavailable and shows why', () => {
    render(
      state({
        activation: {
          pushToTalk: {
        enabled: true,
        mode: 'hold',
        key: 'Hold ?',
        globalAccelerator: 'Super+Alt+Space',
        globalRegistered: true,
      },
          wakeWord: {
            enabled: false,
            phrase: 'hey aria',
            available: false,
            reason: 'The wake-word engine is unavailable on this build.',
          },
          chatShortcut: { enabled: true, accelerator: 'Super+Alt+A', registered: true },
        },
      }),
      'activation',
    );
    const toggle = document.getElementById('wake-word-enabled') as HTMLInputElement | null;
    expect(toggle?.disabled).toBe(true);
    expect(document.body.textContent).toContain('wake-word engine is unavailable');
  });

  it('sends a settings patch when push-to-talk mode changes', () => {
    const { patches } = render(state(), 'activation');
    const select = document.getElementById('push-to-talk-mode') as HTMLSelectElement;
    select.value = 'toggle';
    select.dispatchEvent(new Event('change'));
    expect(patches).toContainEqual({ pushToTalkMode: 'toggle' });
  });

  it('sends a null to clear the language when automatic is chosen', () => {
    const { patches } = render(state(), 'voice');
    const select = document.getElementById('language-select') as HTMLSelectElement;
    select.value = '';
    select.dispatchEvent(new Event('change'));
    expect(patches).toContainEqual({ language: null });
  });

  it('sends a settings patch when a toggle changes', () => {
    const { patches } = render(state(), 'voice');
    const toggle = document.getElementById('speak-responses') as HTMLInputElement;
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    expect(patches).toContainEqual({ speakResponses: false });
  });

  it('opens the chat window through the bridge', () => {
    mount();
    let opened = 0;
    const b: ControlCenterBridge = {
      controlCenterState: async () => state(),
      updateSettings: async () => ({ ok: true }),
      signIn: async () => ({ ok: true, signedIn: true }),
      signOut: async () => ({ ok: true, signedIn: true }),
      openChat: async () => {
        opened += 1;
      },
    };
    renderControlCenter(document, state(), b);
    (document.getElementById('open-chat') as HTMLButtonElement).click();
    expect(opened).toBe(1);
  });

  it('shows an empty task history rather than inventing rows', () => {
    render(state());
    expect(document.body.textContent).toContain('Nothing running');
  });

  it('shows diagnostics and integration state from the sources', () => {
    render(
      state({
        integrations: {
          backend: { state: 'outage', reason: 'Connection refused.' },
          aiEngineer: { state: 'outage', reason: 'Unreachable while the Backend is unavailable.' },
          catalogVersion: '1.0.0',
          capabilities: [],
        },
      }),
      'diagnostics',
    );
    expect(document.body.textContent).toContain('Unreachable');
    expect(document.body.textContent).toContain('Connection refused.');
  });

  it('renders the versioned capability catalog with support state', () => {
    render(state(), 'integrations');
    const catalog = document.querySelector('[data-testid="capability-catalog"]');
    expect(catalog).not.toBeNull();
    const entries = catalog?.querySelectorAll('li.capability');
    expect(entries?.length).toBe(2);
    expect(catalog?.querySelector('[data-supported="yes"]')?.textContent).toContain('Typed chat');
    const unavailable = catalog?.querySelector('[data-supported="no"]');
    expect(unavailable?.textContent).toContain('Wake word');
    expect(unavailable?.textContent).toContain('No wake-word detector');
    expect(document.body.textContent).toContain('Capability catalog v1.0.0');
  });

  it('lists reported errors in diagnostics with source and message', () => {
    render(
      state({
        diagnostics: {
          backendState: 'ok',
          voiceReady: true,
          listening: false,
          checkedAt: 'now',
          incidents: [{ at: '2026-01-01T00:00:01.000Z', source: 'settings:wakeWord', message: 'engine offline' }],
        },
      }),
      'diagnostics',
    );
    expect(document.body.textContent).toContain('settings:wakeWord');
    expect(document.body.textContent).toContain('engine offline');
  });

  it('says no errors were reported when the incident list is empty', () => {
    render(state(), 'diagnostics');
    expect(document.body.textContent).toContain('No errors have been reported this session.');
  });

  it('reports the voice engine honestly instead of claiming capture works', () => {
    render(
      state({
        diagnostics: {
          backendState: 'ok',
          voiceReady: false,
          voiceEngine: 'unavailable',
          voiceEngineReason: 'This build ships without a bound microphone and speaker.',
          listening: false,
          checkedAt: 'now',
          incidents: [],
        },
      }),
      'diagnostics',
    );
    expect(document.body.textContent).toContain('Unavailable');
    expect(document.body.textContent).toContain('without a bound microphone');
  });

  it('shows the configured hold key rather than a hard-coded one', () => {
    render(
      state({
        activation: {
          pushToTalk: {
            enabled: true,
            mode: 'hold',
            key: 'Right Ctrl',
            globalAccelerator: 'Super+Alt+Space',
            globalRegistered: true,
          },
          wakeWord: { enabled: false, phrase: 'hey aria', available: true },
          chatShortcut: { enabled: true, accelerator: 'Super+Alt+A', registered: true },
        },
      }),
      'activation',
    );
    expect(document.body.textContent).toContain('Right Ctrl');
    expect(document.body.textContent).not.toContain('Hold ?');
  });

  it('toggles the Orb presence from the appearance tab', () => {
    const { patches } = render(state(), 'general');
    const toggle = document.getElementById('show-orb') as HTMLInputElement;
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    expect(patches).toContainEqual({ showOrb: false });
  });

  it('applies the chosen accent to the document root', () => {
    render(
      state({ appearance: { accent: 'mint', showOrb: true, startOnLogin: false } }),
      'general',
    );
    expect(document.documentElement.getAttribute('data-accent')).toBe('mint');
  });

  it('clears the accent attribute for the default theme', () => {
    document.documentElement.setAttribute('data-accent', 'rose');
    render(state({ appearance: { accent: 'aurora', showOrb: true, startOnLogin: false } }));
    expect(document.documentElement.hasAttribute('data-accent')).toBe(false);
  });

  it('sends a settings patch when start-on-login changes', () => {
    const { patches } = render(state(), 'general');
    const toggle = document.getElementById('start-on-login') as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    expect(patches).toContainEqual({ startOnLogin: true });
  });
});
