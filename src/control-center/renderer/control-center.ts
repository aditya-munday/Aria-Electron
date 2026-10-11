import type { ControlCenterState } from '../state.js';

export interface ControlCenterBridge {
  controlCenterState(): Promise<ControlCenterState>;
  updateSettings(patch: unknown): Promise<{ ok: boolean; reason?: string }>;
  signIn(input: unknown): Promise<{ ok: boolean; reason?: string; unsupported?: boolean }>;
  signOut(): Promise<{ ok: boolean; reason?: string }>;
  openChat(): Promise<void>;
}

type El = HTMLElement;

const TABS = ['overview', 'voice', 'account', 'diagnostics'] as const;
type TabId = (typeof TABS)[number];

const TAB_META: Record<TabId, { label: string; subtitle: string; icon: string }> = {
  overview: {
    label: 'Overview',
    subtitle: 'Connection, tasks and privacy at a glance.',
    icon: 'M4 13h6V4H4v9Zm10 7h6v-9h-6v9ZM4 20h6v-5H4v5Zm10-11h6V4h-6v5Z',
  },
  voice: {
    label: 'Voice & Keys',
    subtitle: 'How Aria wakes, listens and answers.',
    icon: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm7 9a7 7 0 0 1-6 6.9V22h-2v-3.1A7 7 0 0 1 5 12h2a5 5 0 0 0 10 0h2Z',
  },
  account: {
    label: 'Account',
    subtitle: 'Sign in to the Beyonders backend.',
    icon: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-4 0-7 2.2-7 5v1h14v-1c0-2.8-3-5-7-5Z',
  },
  diagnostics: {
    label: 'Diagnostics',
    subtitle: 'Raw capability and connectivity state.',
    icon: 'M3 13h4l2 5 4-13 2 8h6',
  },
};

function h<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className !== undefined) node.className = className;
  return node;
}

function text(node: El, value: string): void {
  node.textContent = value;
}

function icon(doc: Document, path: string): SVGSVGElement {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'glyph');
  svg.setAttribute('aria-hidden', 'true');
  const p = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', path);
  p.setAttribute('fill', 'currentColor');
  svg.append(p);
  return svg;
}

function card(doc: Document, title: string, className = ''): El {
  const wrap = h(doc, 'section', `card ${className}`.trim());
  const head = h(doc, 'div', 'card-head');
  const heading = h(doc, 'h2');
  text(heading, title);
  head.append(heading);
  wrap.append(head);
  return wrap;
}

function hint(doc: Document, value: string): El {
  const p = h(doc, 'p', 'hint');
  text(p, value);
  return p;
}

function row(doc: Document, label: string, value: string, reason?: string, mono = false): El {
  const line = h(doc, 'div', 'row');
  const name = h(doc, 'span', 'row-label');
  text(name, label);
  const val = h(doc, 'span', `row-value${mono ? ' mono' : ''}`);
  text(val, value);
  line.append(name, val);
  if (reason !== undefined) {
    const note = h(doc, 'p', 'muted reason');
    text(note, reason);
    line.append(note);
  }
  return line;
}

function toggle(
  doc: Document,
  id: string,
  label: string,
  checked: boolean,
  enabled: boolean,
  reason: string | undefined,
  onChange: (next: boolean) => void,
): El {
  const line = h(doc, 'label', 'control');
  const input = h(doc, 'input', 'switch-input');
  input.type = 'checkbox';
  input.id = id;
  input.checked = checked;
  input.disabled = !enabled;
  input.addEventListener('change', () => onChange(input.checked));
  const knob = h(doc, 'span', 'switch');
  knob.setAttribute('aria-hidden', 'true');
  const name = h(doc, 'span', 'row-label');
  text(name, label);
  line.append(input, knob, name);
  if (reason !== undefined) {
    const note = h(doc, 'p', 'muted reason');
    text(note, reason);
    line.append(note);
  }
  return line;
}

function select(
  doc: Document,
  id: string,
  label: string,
  value: string,
  options: readonly { readonly value: string; readonly label: string }[],
  enabled: boolean,
  reason: string | undefined,
  onChange: (next: string) => void,
): El {
  const line = h(doc, 'label', 'control');
  const name = h(doc, 'span', 'row-label');
  text(name, label);
  const node = h(doc, 'select');
  node.id = id;
  node.disabled = !enabled;
  for (const option of options) {
    const opt = h(doc, 'option');
    opt.value = option.value;
    opt.textContent = option.label;
    if (option.value === value) opt.selected = true;
    node.append(opt);
  }
  node.addEventListener('change', () => onChange(node.value));
  line.append(name, node);
  if (reason !== undefined) {
    const note = h(doc, 'p', 'muted reason');
    text(note, reason);
    line.append(note);
  }
  return line;
}

function button(
  doc: Document,
  id: string,
  label: string,
  className: string,
  enabled: boolean,
  onClick: () => void,
): HTMLButtonElement {
  const node = h(doc, 'button', `btn ${className}`.trim());
  node.id = id;
  node.disabled = !enabled;
  text(node, label);
  node.addEventListener('click', onClick);
  return node;
}

function badge(doc: Document, value: string, tone: 'ok' | 'warn' | 'bad' | 'neutral'): El {
  const node = h(doc, 'span', 'badge');
  node.setAttribute('data-tone', tone);
  text(node, value);
  return node;
}

function stat(doc: Document, value: string, label: string): El {
  const wrap = h(doc, 'div', 'stat');
  const v = h(doc, 'div', 'stat-value');
  text(v, value);
  const l = h(doc, 'div', 'stat-label');
  text(l, label);
  wrap.append(v, l);
  return wrap;
}

function emptyState(doc: Document, title: string, detail: string): El {
  const wrap = h(doc, 'div', 'empty');
  const big = h(doc, 'div', 'big');
  text(big, title);
  const small = h(doc, 'div');
  text(small, detail);
  wrap.append(big, small);
  return wrap;
}

function keys(doc: Document, accelerator: string): El {
  const wrap = h(doc, 'span', 'keys');
  for (const part of accelerator.split('+')) {
    const k = h(doc, 'kbd');
    text(k, part);
    wrap.append(k);
  }
  return wrap;
}

function backendTone(state: ControlCenterState['diagnostics']['backendState']): 'ok' | 'warn' | 'bad' {
  if (state === 'ok') return 'ok';
  if (state === 'outage') return 'bad';
  return 'warn';
}

function backendWord(state: ControlCenterState['diagnostics']['backendState']): string {
  switch (state) {
    case 'ok':
      return 'Connected';
    case 'outage':
      return 'Unreachable';
    case 'unauthenticated':
      return 'Sign-in required';
    case 'unconfigured':
      return 'Not configured';
    default:
      return 'Unknown';
  }
}

function overviewPanel(doc: Document, state: ControlCenterState): El {
  const panel = h(doc, 'div', 'panel');
  panel.setAttribute('role', 'tabpanel');
  panel.id = 'panel-overview';

  const summary = card(doc, 'At a glance', 'span-2');
  const stats = h(doc, 'div', 'stats');
  stats.append(
    stat(doc, backendWord(state.diagnostics.backendState), 'Backend'),
    stat(doc, String(state.tasks.length), state.tasks.length === 1 ? 'Task' : 'Tasks'),
    stat(doc, state.voice.speakResponses ? 'On' : 'Off', 'Spoken replies'),
    stat(doc, state.account.state === 'signed_in' ? 'Yes' : 'No', 'Signed in'),
  );
  summary.append(stats);

  const integrations = card(doc, 'Integrations');
  integrations.append(
    row(
      doc,
      'Aria backend',
      backendWord(state.integrations.backend.state),
      state.integrations.backend.reason,
    ),
    row(
      doc,
      'AI Engineer',
      backendWord(state.integrations.aiEngineer.state),
      state.integrations.aiEngineer.reason,
    ),
  );

  const privacy = card(doc, 'Privacy & data');
  privacy.append(
    row(
      doc,
      'Token storage',
      state.privacy.tokenStored === 'memory_only' ? 'Memory only' : state.privacy.tokenStored,
    ),
    row(doc, 'Conversation retention', 'Opted out', state.privacy.retentionReason),
  );
  for (const note of state.privacy.notes) {
    const line = h(doc, 'p', 'muted');
    text(line, note);
    privacy.append(line);
  }

  const tasks = card(doc, 'Task history', 'span-2');
  if (state.tasks.length === 0) {
    tasks.append(
      emptyState(doc, 'Nothing running', 'Requests you submit through the backend show up here.'),
    );
  } else {
    const list = h(doc, 'ul', 'tasks');
    for (const task of state.tasks) {
      const item = h(doc, 'li', 'task');
      const top = h(doc, 'div', 'task-top');
      const title = h(doc, 'span', 'task-title');
      text(title, task.title);
      top.append(title, badge(doc, task.phase, 'neutral'));
      const meta = h(doc, 'div', 'task-meta');
      text(meta, `${task.status} · verification ${task.verification} · ${task.updatedAt}`);
      item.append(top, meta);
      list.append(item);
    }
    tasks.append(list);
  }

  panel.append(summary, integrations, privacy, tasks);
  return panel;
}

function voicePanel(
  doc: Document,
  state: ControlCenterState,
  bridge: ControlCenterBridge,
  refresh: () => void,
): El {
  const panel = h(doc, 'div', 'panel');
  panel.setAttribute('role', 'tabpanel');
  panel.id = 'panel-voice';

  const voice = state.voice;
  const speech = card(doc, 'Speech');
  speech.append(hint(doc, 'Pick the synthesis voice and language the backend should speak with.'));
  const catalogEnabled = voice.catalogState === 'available';
  const catalogReason =
    voice.catalogState === 'available'
      ? undefined
      : voice.reason ?? 'The voice catalog is unavailable right now.';
  const options =
    voice.voices.length > 0
      ? voice.voices.map((v) => ({ value: v.id, label: `${v.name} (${v.language})` }))
      : [{ value: '', label: 'No voices available' }];
  speech.append(
    select(
      doc,
      'voice-select',
      'Synthesis voice',
      voice.configured ?? '',
      options,
      catalogEnabled,
      catalogReason,
      (next) => {
        void bridge.updateSettings({ voice: next === '' ? null : next }).then(refresh);
      },
    ),
    select(
      doc,
      'language-select',
      'Language',
      voice.language ?? '',
      [
        { value: '', label: 'Backend default' },
        { value: 'en-US', label: 'English (United States)' },
        { value: 'en-GB', label: 'English (United Kingdom)' },
      ],
      true,
      undefined,
      (next) => {
        void bridge.updateSettings({ language: next === '' ? null : next }).then(refresh);
      },
    ),
    toggle(
      doc,
      'speak-responses',
      'Speak responses aloud',
      voice.speakResponses,
      true,
      undefined,
      (next) => {
        void bridge.updateSettings({ speakResponses: next }).then(refresh);
      },
    ),
  );

  const activation = state.activation;
  const keysCard = card(doc, 'Activation & keys');
  keysCard.append(
    toggle(
      doc,
      'push-to-talk-enabled',
      'Push to talk',
      activation.pushToTalk.enabled,
      true,
      undefined,
      (next) => {
        void bridge.updateSettings({ pushToTalkEnabled: next }).then(refresh);
      },
    ),
  );
  const pttKeyRow = h(doc, 'div', 'row');
  const pttLabel = h(doc, 'span', 'row-label');
  text(pttLabel, 'Hold key');
  pttKeyRow.append(pttLabel, keys(doc, 'Right Ctrl'));
  keysCard.append(pttKeyRow);

  const globalRow = h(doc, 'div', 'row');
  const globalLabel = h(doc, 'span', 'row-label');
  text(globalLabel, 'Global toggle');
  globalRow.append(globalLabel, keys(doc, activation.pushToTalk.globalAccelerator));
  if (!activation.pushToTalk.globalRegistered) {
    const warn = h(doc, 'p', 'muted reason');
    text(
      warn,
      `Another application holds ${activation.pushToTalk.globalAccelerator}; the global toggle is unavailable.`,
    );
    globalRow.append(warn);
  }
  keysCard.append(globalRow);
  keysCard.append(
    select(
      doc,
      'push-to-talk-mode',
      'Push-to-talk mode',
      activation.pushToTalk.mode,
      [
        { value: 'hold', label: 'Hold to talk' },
        { value: 'toggle', label: 'Press to toggle' },
      ],
      true,
      undefined,
      (next) => {
        void bridge.updateSettings({ pushToTalkMode: next }).then(refresh);
      },
    ),
    toggle(
      doc,
      'wake-word-enabled',
      `Wake word (“${activation.wakeWord.phrase}”)`,
      activation.wakeWord.enabled,
      activation.wakeWord.available,
      activation.wakeWord.available ? undefined : activation.wakeWord.reason,
      (next) => {
        void bridge.updateSettings({ wakeWordEnabled: next }).then(refresh);
      },
    ),
  );
  const chatRow = h(doc, 'label', 'control');
  const chatInput = h(doc, 'input', 'switch-input');
  chatInput.type = 'checkbox';
  chatInput.id = 'chat-shortcut-enabled';
  chatInput.checked = activation.chatShortcut.enabled;
  chatInput.addEventListener('change', () => {
    void bridge.updateSettings({ chatShortcutEnabled: chatInput.checked }).then(refresh);
  });
  const chatKnob = h(doc, 'span', 'switch');
  chatKnob.setAttribute('aria-hidden', 'true');
  const chatLabel = h(doc, 'span', 'row-label');
  text(chatLabel, 'Open chat shortcut');
  chatRow.append(chatInput, chatKnob, chatLabel, keys(doc, activation.chatShortcut.accelerator));
  keysCard.append(chatRow);
  if (!activation.chatShortcut.registered) {
    const warn = h(doc, 'p', 'muted reason');
    text(
      warn,
      `Another application holds ${activation.chatShortcut.accelerator}; the chat shortcut is unavailable.`,
    );
    keysCard.append(warn);
  }

  panel.append(speech, keysCard);
  return panel;
}

function accountPanel(
  doc: Document,
  state: ControlCenterState,
  bridge: ControlCenterBridge,
  refresh: () => void,
): El {
  const panel = h(doc, 'div', 'panel');
  panel.setAttribute('role', 'tabpanel');
  panel.id = 'panel-account';

  const account = state.account;
  const wrap = card(doc, account.state === 'signed_in' ? 'Your account' : 'Sign in', 'span-2');

  if (account.state === 'signed_in') {
    const identity = h(doc, 'div', 'identity');
    const who = h(doc, 'div', 'who');
    text(who, account.email ?? account.userId ?? 'Signed in');
    const mail = h(doc, 'div', 'mail');
    text(
      mail,
      [account.userId, account.roles?.length ? `roles: ${account.roles.join(', ')}` : '']
        .filter((part) => part !== '')
        .join(' · '),
    );
    identity.append(who, mail);
    wrap.append(identity);
    wrap.append(
      row(doc, 'Providers', account.providers?.join(', ') ?? 'none'),
      row(doc, 'Anonymous', account.anonymous === true ? 'yes' : 'no'),
    );
    const actions = h(doc, 'div', 'auth-actions');
    actions.append(
      button(doc, 'account-sign-out', 'Sign out', 'danger', true, () => {
        void bridge.signOut().then(refresh);
      }),
    );
    wrap.append(actions);
    panel.append(wrap);
    return panel;
  }

  if (account.state === 'unknown') {
    wrap.append(
      hint(
        doc,
        account.reason ??
          'The backend did not answer, so the sign-in state could not be determined.',
      ),
    );
    const actions = h(doc, 'div', 'auth-actions');
    actions.append(button(doc, 'account-retry', 'Retry', 'ghost', true, refresh));
    wrap.append(actions);
    panel.append(wrap);
    return panel;
  }

  wrap.append(
    hint(doc, 'Aria holds your token in memory for this session only — it is never written to disk.'),
  );
  const form = h(doc, 'form', 'auth-form');
  const emailField = h(doc, 'div', 'field');
  const emailLabel = h(doc, 'label');
  emailLabel.setAttribute('for', 'account-email');
  text(emailLabel, 'Email');
  const email = h(doc, 'input');
  email.type = 'email';
  email.id = 'account-email';
  email.autocomplete = 'username';
  email.placeholder = 'you@example.com';
  emailField.append(emailLabel, email);

  const tokenField = h(doc, 'div', 'field');
  const tokenLabel = h(doc, 'label');
  tokenLabel.setAttribute('for', 'account-token');
  text(tokenLabel, 'Session token');
  const token = h(doc, 'input');
  token.type = 'password';
  token.id = 'account-token';
  token.autocomplete = 'current-password';
  token.placeholder = 'Paste your Aria session token';
  tokenField.append(tokenLabel, token);

  const actions = h(doc, 'div', 'auth-actions');
  const note = h(doc, 'p', 'auth-note');
  const signInButton = button(doc, 'account-sign-in', 'Sign in', 'primary', true, () => undefined);
  signInButton.type = 'submit';
  actions.append(signInButton);
  form.append(emailField, tokenField, actions, note);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = token.value.trim();
    if (value === '') {
      note.setAttribute('data-tone', 'bad');
      text(note, 'Enter your session token to continue.');
      token.focus();
      return;
    }
    signInButton.disabled = true;
    text(note, 'Signing in…');
    void bridge.signIn({ token: value, email: email.value.trim() }).then((result) => {
      if (result.ok) {
        refresh();
        return;
      }
      signInButton.disabled = false;
      note.setAttribute('data-tone', 'bad');
      text(
        note,
        result.unsupported === true
          ? result.reason ?? 'Sign-in is not available in this build.'
          : result.reason ?? 'Sign-in failed.',
      );
    });
  });
  wrap.append(form);
  panel.append(wrap);
  return panel;
}

function diagnosticsPanel(doc: Document, state: ControlCenterState): El {
  const panel = h(doc, 'div', 'panel');
  panel.setAttribute('role', 'tabpanel');
  panel.id = 'panel-diagnostics';

  const d = state.diagnostics;
  const backend = card(doc, 'Backend');
  const head = backend.querySelector('.card-head');
  head?.append(badge(doc, backendWord(d.backendState), backendTone(d.backendState)));
  backend.append(
    row(doc, 'Reachability', backendWord(d.backendState), d.backendReason),
    row(doc, 'Voice input', d.voiceReady ? 'Ready' : 'Not ready', d.voiceReason),
    row(doc, 'Listening', d.listening ? 'yes' : 'no'),
    row(doc, 'Checked at', d.checkedAt),
  );
  if (d.voiceDetail !== undefined) backend.append(row(doc, 'Detail', d.voiceDetail));

  const runtime = card(doc, 'Runtime');
  runtime.append(
    row(doc, 'Model', state.ariaConfig.model.displayName, 'Fixed for this release.'),
    row(doc, 'Request timeout', `${state.ariaConfig.requestTimeoutMs} ms`),
    row(
      doc,
      'Microphone device',
      state.ariaConfig.microphoneDeviceId ?? 'System default',
      'Device selection is not wired in this release.',
    ),
  );

  panel.append(backend, runtime);
  return panel;
}

function connectionState(state: ControlCenterState): string {
  const value = state.diagnostics.backendState;
  if (value === 'ok') return 'ok';
  if (value === 'outage') return 'outage';
  return 'unknown';
}

function renderSidebar(
  doc: Document,
  state: ControlCenterState,
  active: TabId,
  onSelect: (tab: TabId) => void,
): El {
  const nav = h(doc, 'nav', 'sidebar');
  nav.setAttribute('aria-label', 'Sections');

  const brand = h(doc, 'div', 'brand');
  const mark = h(doc, 'div', 'brand-mark');
  mark.setAttribute('aria-hidden', 'true');
  const name = h(doc, 'div', 'brand-name');
  text(name, 'Aria');
  const sub = h(doc, 'small');
  text(sub, 'Control Center');
  name.append(sub);
  brand.append(mark, name);
  nav.append(brand);

  const tabs = h(doc, 'div', 'tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-orientation', 'vertical');
  for (const id of TABS) {
    const meta = TAB_META[id];
    const tab = h(doc, 'button', 'tab');
    tab.setAttribute('role', 'tab');
    tab.id = `tab-${id}`;
    tab.setAttribute('aria-controls', `panel-${id}`);
    tab.setAttribute('aria-selected', String(id === active));
    tab.append(icon(doc, meta.icon));
    const label = h(doc, 'span');
    text(label, meta.label);
    tab.append(label);
    tab.addEventListener('click', () => onSelect(id));
    tabs.append(tab);
  }
  nav.append(tabs);

  const foot = h(doc, 'div', 'sidebar-foot');
  const conn = h(doc, 'div', 'conn');
  conn.setAttribute('data-state', connectionState(state));
  const dot = h(doc, 'span', 'dot');
  dot.setAttribute('aria-hidden', 'true');
  const connText = h(doc, 'span');
  text(connText, backendWord(state.diagnostics.backendState));
  conn.append(dot, connText);
  const acct = h(doc, 'div', 'acct');
  text(
    acct,
    state.account.state === 'signed_in'
      ? state.account.email ?? state.account.userId ?? 'Signed in'
      : 'Not signed in',
  );
  foot.append(conn, acct);
  nav.append(foot);

  return nav;
}

export function renderControlCenter(
  doc: Document,
  state: ControlCenterState,
  bridge: ControlCenterBridge,
  activeTab: TabId = 'overview',
): void {
  const root = doc.getElementById('control-center');
  if (root === null) return;
  root.setAttribute('aria-busy', 'false');

  const refresh = (): void => {
    void bridge
      .controlCenterState()
      .then((next) => renderControlCenter(doc, next, bridge, activeTab));
  };
  const select = (tab: TabId): void => {
    renderControlCenter(doc, state, bridge, tab);
  };

  const sidebar = root.querySelector('.sidebar');
  const topbar = root.querySelector('.topbar');
  const panels = root.querySelector('.panels');
  if (sidebar === null || topbar === null || panels === null) return;

  sidebar.replaceWith(renderSidebar(doc, state, activeTab, select));

  const titleWrap = h(doc, 'div');
  const title = h(doc, 'h1', 'title');
  text(title, TAB_META[activeTab].label);
  const subtitle = h(doc, 'p', 'subtitle');
  text(subtitle, TAB_META[activeTab].subtitle);
  titleWrap.append(title, subtitle);
  const actions = h(doc, 'div', 'topbar-actions');
  actions.append(
    button(doc, 'refresh-state', 'Refresh', 'ghost', true, refresh),
    button(doc, 'open-chat', 'Open chat', 'primary', true, () => {
      void bridge.openChat();
    }),
  );
  topbar.replaceChildren(titleWrap, actions);

  const panelsToRender: Record<TabId, El> = {
    overview: overviewPanel(doc, state),
    voice: voicePanel(doc, state, bridge, refresh),
    account: accountPanel(doc, state, bridge, refresh),
    diagnostics: diagnosticsPanel(doc, state),
  };
  for (const id of TABS) {
    panelsToRender[id].setAttribute('data-active', String(id === activeTab));
  }
  panels.replaceChildren(
    panelsToRender.overview,
    panelsToRender.voice,
    panelsToRender.account,
    panelsToRender.diagnostics,
  );
}

export function bootstrapControlCenter(doc: Document, bridge: ControlCenterBridge): void {
  void bridge.controlCenterState().then((state) => renderControlCenter(doc, state, bridge));
}

declare global {
  interface Window {
    aria?: ControlCenterBridge;
  }
}

const injected = (globalThis as { aria?: ControlCenterBridge }).aria;

if (typeof document !== 'undefined' && injected !== undefined) {
  bootstrapControlCenter(document, injected);
}
