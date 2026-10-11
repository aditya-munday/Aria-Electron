import type { ControlCenterState } from '../state.js';

export interface ControlCenterBridge {
  controlCenterState(): Promise<ControlCenterState>;
  updateSettings(patch: unknown): Promise<{ ok: boolean; reason?: string }>;
  signIn(input: unknown): Promise<{ ok: boolean; reason?: string; unsupported?: boolean }>;
  signOut(): Promise<{ ok: boolean; reason?: string }>;
}

type El = HTMLElement;

function h<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className !== undefined) node.className = className;
  return node;
}

function setText(node: El, value: string): void {
  node.textContent = value;
}

function section(doc: Document, title: string): El {
  const wrap = h(doc, 'section', 'card');
  const heading = h(doc, 'h2');
  setText(heading, title);
  wrap.append(heading);
  return wrap;
}

function row(doc: Document, label: string, value: string, reason?: string): El {
  const line = h(doc, 'div', 'row');
  const name = h(doc, 'span', 'row-label');
  setText(name, label);
  const val = h(doc, 'span', 'row-value');
  setText(val, value);
  line.append(name, val);
  if (reason !== undefined) {
    const note = h(doc, 'p', 'muted reason');
    setText(note, reason);
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
  const line = h(doc, 'label', 'row control');
  const input = h(doc, 'input');
  input.type = 'checkbox';
  input.id = id;
  input.checked = checked;
  input.disabled = !enabled;
  input.addEventListener('change', () => onChange(input.checked));
  const name = h(doc, 'span', 'row-label');
  setText(name, label);
  line.append(input, name);
  if (reason !== undefined) {
    const note = h(doc, 'p', 'muted reason');
    setText(note, reason);
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
  const line = h(doc, 'label', 'row control');
  const name = h(doc, 'span', 'row-label');
  setText(name, label);
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
    setText(note, reason);
    line.append(note);
  }
  return line;
}

function button(
  doc: Document,
  id: string,
  label: string,
  enabled: boolean,
  reason: string | undefined,
  onClick: () => void,
): El {
  const wrap = h(doc, 'div', 'control');
  const node = h(doc, 'button');
  node.id = id;
  node.disabled = !enabled;
  setText(node, label);
  node.addEventListener('click', onClick);
  wrap.append(node);
  if (reason !== undefined) {
    const note = h(doc, 'p', 'muted reason');
    setText(note, reason);
    wrap.append(note);
  }
  return wrap;
}

function accountSection(
  doc: Document,
  state: ControlCenterState,
  bridge: ControlCenterBridge,
  refresh: () => void,
): El {
  const account = state.account;
  const wrap = section(doc, 'Profile');
  if (account.state === 'signed_in') {
    wrap.append(row(doc, 'Signed in as', account.userId ?? 'unknown'));
    wrap.append(row(doc, 'Email', account.email ?? 'not provided'));
    wrap.append(row(doc, 'Roles', account.roles?.join(', ') ?? 'none'));
    wrap.append(row(doc, 'Providers', account.providers?.join(', ') ?? 'none'));
    wrap.append(row(doc, 'Anonymous', account.anonymous === true ? 'yes' : 'no'));
    wrap.append(
      button(doc, 'account-sign-out', 'Sign out', true, undefined, () => {
        void bridge.signOut().then(refresh);
      }),
    );
  } else if (account.state === 'signed_out') {
    wrap.append(row(doc, 'Status', 'Not signed in'));
    wrap.append(
      button(doc, 'account-sign-in', 'Sign in', true, undefined, () => {
        void bridge.signIn({}).then((result) => {
          if (!result.ok) {
            const note = h(doc, 'p', 'muted reason');
            setText(note, result.reason ?? 'Sign-in failed.');
            wrap.append(note);
          } else {
            refresh();
          }
        });
      }),
    );
  } else {
    wrap.append(row(doc, 'Status', 'Unknown', account.reason));
  }
  return wrap;
}

function voiceSection(
  doc: Document,
  state: ControlCenterState,
  bridge: ControlCenterBridge,
  refresh: () => void,
): El {
  const voice = state.voice;
  const wrap = section(doc, 'Voice and speech');

  const catalogEnabled = voice.catalogState === 'available';
  const catalogReason =
    voice.catalogState === 'available'
      ? undefined
      : voice.reason ?? 'The voice catalog is unavailable right now.';
  const options =
    voice.voices.length > 0
      ? voice.voices.map((v) => ({ value: v.id, label: `${v.name} (${v.language})` }))
      : [{ value: '', label: 'No voices available' }];
  wrap.append(
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
  );
  wrap.append(
    toggle(
      doc,
      'speak-responses',
      'Speak responses',
      voice.speakResponses,
      true,
      undefined,
      (next) => {
        void bridge.updateSettings({ speakResponses: next }).then(refresh);
      },
    ),
  );
  return wrap;
}

function activationSection(
  doc: Document,
  state: ControlCenterState,
  bridge: ControlCenterBridge,
  refresh: () => void,
): El {
  const activation = state.activation;
  const wrap = section(doc, 'Activation');
  wrap.append(
    toggle(
      doc,
      'push-to-talk-enabled',
      `Push to talk (${activation.pushToTalk.key})`,
      activation.pushToTalk.enabled,
      true,
      undefined,
      (next) => {
        void bridge.updateSettings({ pushToTalkEnabled: next }).then(refresh);
      },
    ),
  );
  wrap.append(
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
  );
  wrap.append(
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
  wrap.append(
    toggle(
      doc,
      'chat-shortcut-enabled',
      `Chat shortcut (${activation.chatShortcut.accelerator})`,
      activation.chatShortcut.enabled,
      true,
      undefined,
      (next) => {
        void bridge.updateSettings({ chatShortcutEnabled: next }).then(refresh);
      },
    ),
  );
  return wrap;
}

function configSection(
  doc: Document,
  state: ControlCenterState,
  bridge: ControlCenterBridge,
  refresh: () => void,
): El {
  const config = state.ariaConfig;
  const wrap = section(doc, 'Configuration');
  const language = config.options.find((o) => o.id === 'language')?.value ?? 'Backend default';
  wrap.append(
    select(
      doc,
      'language-select',
      'Language',
      language === 'Backend default' ? '' : language,
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
  );
  wrap.append(
    row(
      doc,
      'Microphone device',
      config.microphoneDeviceId ?? 'System default',
      'Device selection is not wired in this release; the system default is used.',
    ),
  );
  for (const option of config.options) {
    if (option.id === 'language' || option.id === 'speakResponses' || option.id === 'voice') continue;
    wrap.append(row(doc, option.label, option.value, option.editable ? undefined : option.reason));
  }
  wrap.append(row(doc, 'Backend base URL', config.backendBaseUrl));
  wrap.append(row(doc, 'Request timeout', `${config.requestTimeoutMs} ms`));
  return wrap;
}

function privacySection(doc: Document, state: ControlCenterState): El {
  const privacy = state.privacy;
  const wrap = section(doc, 'Privacy and data');
  wrap.append(
    row(doc, 'Token storage', privacy.tokenStored === 'memory_only' ? 'Memory only' : privacy.tokenStored),
  );
  wrap.append(row(doc, 'Conversation retention', 'Opted out', privacy.retentionReason));
  for (const note of privacy.notes) {
    const line = h(doc, 'p', 'muted');
    setText(line, note);
    wrap.append(line);
  }
  return wrap;
}

function integrationsSection(doc: Document, state: ControlCenterState): El {
  const wrap = section(doc, 'Integrations');
  wrap.append(
    row(doc, 'Aria Backend', state.integrations.backend.state, state.integrations.backend.reason),
  );
  wrap.append(
    row(doc, 'AI Engineer', state.integrations.aiEngineer.state, state.integrations.aiEngineer.reason),
  );
  return wrap;
}

function diagnosticsSection(doc: Document, state: ControlCenterState): El {
  const d = state.diagnostics;
  const wrap = section(doc, 'Diagnostics');
  wrap.append(row(doc, 'Backend', d.backendState, d.backendReason));
  wrap.append(row(doc, 'Voice input', d.voiceReady ? 'Ready' : 'Not ready', d.voiceReason));
  wrap.append(row(doc, 'Listening', d.listening ? 'yes' : 'no'));
  if (d.voiceDetail !== undefined) wrap.append(row(doc, 'Detail', d.voiceDetail));
  wrap.append(row(doc, 'Checked at', d.checkedAt));
  return wrap;
}

function tasksSection(doc: Document, state: ControlCenterState): El {
  const wrap = section(doc, 'Task history');
  if (state.tasks.length === 0) {
    const empty = h(doc, 'p', 'muted');
    setText(empty, 'No tasks yet.');
    wrap.append(empty);
    return wrap;
  }
  for (const task of state.tasks) {
    wrap.append(row(doc, task.title, `${task.phase} · ${task.status} · ${task.verification}`));
  }
  return wrap;
}

export function renderControlCenter(
  doc: Document,
  state: ControlCenterState,
  bridge: ControlCenterBridge,
): void {
  const root = doc.getElementById('control-center');
  if (root === null) return;
  const refresh = (): void => {
    void bridge.controlCenterState().then((next) => renderControlCenter(doc, next, bridge));
  };
  root.replaceChildren(
    accountSection(doc, state, bridge, refresh),
    voiceSection(doc, state, bridge, refresh),
    activationSection(doc, state, bridge, refresh),
    configSection(doc, state, bridge, refresh),
    integrationsSection(doc, state),
    privacySection(doc, state),
    diagnosticsSection(doc, state),
    tasksSection(doc, state),
  );
}

export function bootstrapControlCenter(doc: Document, bridge: ControlCenterBridge): void {
  const main = doc.getElementById('control-center');
  if (main !== null) {
    const loading = h(doc, 'p', 'muted');
    setText(loading, 'Loading Control Center…');
    main.replaceChildren(loading);
  }
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
