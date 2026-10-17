import type { ControlCenterState, VoiceOption } from '../state.js';
import { attachCues, playCue } from '../../renderer/sfx.js';

export interface ControlCenterBridge {
  controlCenterState(): Promise<ControlCenterState>;
  updateSettings(patch: unknown): Promise<{ ok: boolean; reason?: string }>;
  previewVoice(input: unknown): Promise<{ ok: boolean; reason?: string }>;
  signIn(input: unknown): Promise<{ ok: boolean; reason?: string }>;
  signOut(): Promise<{ ok: boolean; reason?: string }>;
  beginLogin(): Promise<{ ok: boolean; reason?: string; loginUrl?: string }>;
  awaitLogin(): Promise<{ ok: boolean; reason?: string }>;
  cancelLogin(): Promise<void>;
  openChat(): Promise<void>;
  quit(): Promise<void>;
  retryShortcuts(): Promise<void>;
}

type El = HTMLElement;

const TABS = [
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
] as const;
type TabId = (typeof TABS)[number];

const ACCENT_OPTIONS = [
  { value: 'aurora', label: 'Aurora (violet)' },
  { value: 'mint', label: 'Mint (teal)' },
  { value: 'amber', label: 'Amber (gold)' },
  { value: 'rose', label: 'Rose (pink)' },
] as const;

const TAB_META: Record<TabId, { label: string; subtitle: string; icon: string }> = {
  profile: {
    label: 'Profile',
    subtitle: 'Who you are and how Aria presents itself.',
    icon: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-4 0-7 2.2-7 5v1h14v-1c0-2.8-3-5-7-5Z',
  },
  account: {
    label: 'Account',
    subtitle: 'Sign in to use Aria.',
    icon: 'M12 2 4 6v6c0 5 3.4 9.4 8 10 4.6-.6 8-5 8-10V6l-8-4Z',
  },
  voice: {
    label: 'Voice & Language',
    subtitle: 'The voice and language Aria answers with.',
    icon: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm7 9a7 7 0 0 1-6 6.9V22h-2v-3.1A7 7 0 0 1 5 12h2a5 5 0 0 0 10 0h2Z',
  },
  activation: {
    label: 'Activation',
    subtitle: 'Wake word, push to talk and shortcuts.',
    icon: 'M4 13h6V4H4v9Zm10 7h6v-9h-6v9ZM4 20h6v-5H4v5Zm10-11h6V4h-6v5Z',
  },
  ariaConfig: {
    label: 'Aria Configuration',
    subtitle: 'Model, timeouts and assistant defaults.',
    icon: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm9 4-2.1-.6-.4-1 1.1-1.9-1.4-1.4-1.9 1.1-1-.4L15 5h-2l-.6 2.1-1 .4L9.5 6.4 8.1 7.8l1.1 1.9-.4 1L6 11v2l2.1.6.4 1-1.1 1.9 1.4 1.4 1.9-1.1 1 .4L11 19h2l.6-2.1 1-.4 1.9 1.1 1.4-1.4-1.1-1.9.4-1L18 13Z',
  },
  privacy: {
    label: 'Privacy & Permissions',
    subtitle: 'Microphone, capture and data controls.',
    icon: 'M12 2 4 6v6c0 5 3.4 9.4 8 10 4.6-.6 8-5 8-10V6l-8-4Zm-1 13-3-3 1.4-1.4L11 12.2l4.6-4.6L17 9l-6 6Z',
  },
  integrations: {
    label: 'Integrations',
    subtitle: 'Connected services and what Aria can do.',
    icon: 'M7 7h10v10H7zM3 3h6v2H5v4H3V3Zm12 0h6v6h-2V5h-4V3ZM3 15h2v4h4v2H3v-6Zm16 0h2v6h-6v-2h4v-4Z',
  },
  tasks: {
    label: 'Tasks & History',
    subtitle: 'Tracked work, results and recovery.',
    icon: 'M6 2h9l5 5v15H6V2Zm8 1.5V8h4.5L14 3.5ZM8 11h8v2H8v-2Zm0 4h8v2H8v-2Z',
  },
  diagnostics: {
    label: 'Diagnostics',
    subtitle: 'Audio, wake-word health and reported issues.',
    icon: 'M3 13h4l3 6 4-16 3 10h4v2h-5.5l-1.5-5-3.5 14-4.5-9H3v-2Z',
  },
  general: {
    label: 'General',
    subtitle: 'Orb presence, startup and appearance.',
    icon: 'M12 3a9 9 0 1 0 0 18 4 4 0 0 0 0-8 4 4 0 0 1 0-8Z',
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

/**
 * The Aria mark: the shipped brand image, scaled by CSS. Drawn as an <img> so
 * the logo is the single source of truth shared with the desktop icon rather
 * than a second, hand-drawn approximation.
 */
function brandMark(doc: Document): HTMLImageElement {
  const img = doc.createElement('img');
  img.className = 'brand-glyph';
  img.src = './logo.png';
  img.alt = 'Aria';
  img.draggable = false;
  return img;
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
  const name = h(doc, 'span', 'row-label');
  text(name, label);
  const knob = h(doc, 'span', 'switch');
  knob.setAttribute('aria-hidden', 'true');
  line.append(input, name, knob);
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

function capabilityCatalog(doc: Document, view: ControlCenterState['integrations']): El {
  const list = h(doc, 'ul', 'capabilities');
  list.setAttribute('data-testid', 'capability-catalog');
  for (const capability of view.capabilities) {
    const item = h(doc, 'li', 'capability');
    item.setAttribute('data-supported', capability.supported ? 'yes' : 'no');
    const top = h(doc, 'div', 'capability-top');
    const title = h(doc, 'span', 'capability-title');
    text(title, capability.title);
    top.append(
      title,
      badge(doc, capability.supported ? 'Available' : 'Unavailable', capability.supported ? 'ok' : 'neutral'),
    );
    const meta = h(doc, 'div', 'capability-meta');
    text(
      meta,
      `${capability.id} · privilege ${capability.privilege} · approval ${capability.approval} · risk ${capability.risk}`,
    );
    item.append(top, meta);
    if (!capability.supported && capability.reason !== undefined) {
      const reason = h(doc, 'p', 'muted reason');
      text(reason, capability.reason);
      item.append(reason);
    }
    list.append(item);
  }
  const note = h(doc, 'p', 'muted');
  text(note, `Capability catalog v${view.catalogVersion}`);
  const wrap = h(doc, 'div', 'capability-block');
  wrap.append(list, note);
  return wrap;
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

function integrationsPanel(doc: Document, state: ControlCenterState): El {
  const panel = h(doc, 'div', 'panel');
  panel.setAttribute('role', 'tabpanel');
  panel.id = 'panel-integrations';

  const integrations = card(doc, 'Integrations', 'span-2');
  integrations.append(
    row(
      doc,
      'Aria',
      backendWord(state.integrations.backend.state),
      state.integrations.backend.reason,
    ),
    row(
      doc,
      'Engineering tasks',
      backendWord(state.integrations.aiEngineer.state),
      state.integrations.aiEngineer.reason,
    ),
  );
  integrations.append(capabilityCatalog(doc, state.integrations));

  panel.append(integrations);
  return panel;
}

function privacyPanel(doc: Document, state: ControlCenterState): El {
  const panel = h(doc, 'div', 'panel');
  panel.setAttribute('role', 'tabpanel');
  panel.id = 'panel-privacy';

  const data = card(doc, 'Privacy & data', 'span-2');
  data.append(
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
    data.append(line);
  }

  const permissions = card(doc, 'Permissions', 'span-2');
  permissions.append(
    row(
      doc,
      'Microphone capture',
      state.diagnostics.voiceReady ? 'Available' : 'Not available',
      state.diagnostics.voiceReason,
    ),
    row(
      doc,
      'Wake word',
      state.activation.wakeWord.available ? 'Available' : 'Not available',
      state.activation.wakeWord.reason,
    ),
  );

  panel.append(data, permissions);
  return panel;
}

function tasksPanel(doc: Document, state: ControlCenterState): El {
  const panel = h(doc, 'div', 'panel');
  panel.setAttribute('role', 'tabpanel');
  panel.id = 'panel-tasks';

  const tasks = card(doc, 'Task history', 'span-2');
  if (state.tasks.length === 0) {
    tasks.append(
      emptyState(doc, 'Nothing running', 'Requests you submit show up here.'),
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

  panel.append(tasks);
  return panel;
}

function generalPanel(
  doc: Document,
  state: ControlCenterState,
  bridge: ControlCenterBridge,
  refresh: () => void,
): El {
  const panel = h(doc, 'div', 'panel');
  panel.setAttribute('role', 'tabpanel');
  panel.id = 'panel-general';

  const appearance = state.appearance;
  const presence = card(doc, 'Presence & startup');
  presence.append(
    hint(
      doc,
      'The Orb appears while Aria is listening, thinking or speaking, then steps away a few seconds after the reply. Keep it on screen to have it stay put.',
    ),
    toggle(
      doc,
      'show-orb',
      'Keep the Orb on screen',
      appearance.showOrb,
      true,
      undefined,
      (next) => {
        void bridge.updateSettings({ showOrb: next }).then(refresh);
      },
    ),
    toggle(
      doc,
      'start-on-login',
      'Start Aria when you sign in',
      appearance.startOnLogin,
      true,
      'Aria writes an XDG autostart entry so it launches when you sign in.',
      (next) => {
        void bridge.updateSettings({ startOnLogin: next }).then(refresh);
      },
    ),
  );

  const theme = card(doc, 'Accent');
  theme.append(hint(doc, 'Tint the Control Center interface to match your desktop.'));
  theme.append(
    select(
      doc,
      'accent-select',
      'Accent theme',
      appearance.accent,
      ACCENT_OPTIONS,
      true,
      undefined,
      (next) => {
        void bridge.updateSettings({ accent: next }).then(refresh);
      },
    ),
  );

  const notifications = card(doc, 'Notifications & updates');
  notifications.append(
    row(
      doc,
      'Desktop notifications',
      'Not wired',
      'Aria does not raise desktop notifications in this release.',
    ),
    row(
      doc,
      'Automatic updates',
      'Not wired',
      'This build is installed from a package; it does not self-update.',
    ),
  );

  const quitCard = card(doc, 'Stopping Aria');
  quitCard.append(
    hint(
      doc,
      'Aria has no system tray, so nothing else keeps it running. Quitting stops wake-word listening and the global shortcuts: Aria will not be there for help until you launch it again.',
    ),
    button(doc, 'quit-aria', 'Quit Aria', 'danger', true, () => {
      void bridge.quit();
    }),
  );

  panel.append(presence, theme, notifications, quitCard);
  return panel;
}

function profilePanel(
  doc: Document,
  state: ControlCenterState,
  bridge: ControlCenterBridge,
  refresh: () => void,
): El {
  const panel = h(doc, 'div', 'panel');
  panel.setAttribute('role', 'tabpanel');
  panel.id = 'panel-profile';

  const account = state.account;
  const signedIn = account.state === 'signed_in';
  const displayName = signedIn
    ? account.email ?? account.userId ?? 'Signed in'
    : 'Not signed in';

  const identity = card(doc, 'Profile', 'span-2');
  const head = h(doc, 'div', 'identity');
  const avatar = h(doc, 'div', 'avatar');
  avatar.setAttribute('aria-hidden', 'true');
  text(avatar, initials(signedIn ? account.email ?? account.userId ?? 'Aria' : 'Aria'));
  const who = h(doc, 'div', 'who');
  text(who, displayName);
  const mail = h(doc, 'div', 'mail');
  text(
    mail,
    signedIn
      ? [account.userId, account.roles?.length ? `roles: ${account.roles.join(', ')}` : '']
          .filter((part) => part !== '' && part !== undefined)
          .join(' · ')
      : 'Sign in under Account to use Aria.',
  );
  const status = h(doc, 'div', 'identity-status');
  status.append(badge(doc, signedIn ? 'Connected' : 'Offline', signedIn ? 'ok' : 'neutral'));
  who.append(status);
  head.append(avatar, who, mail);
  identity.append(head, row(doc, 'Assistant', 'Aria', 'Your local-first voice assistant.'));

  const glance = card(doc, 'At a glance', 'span-2');
  const selectedVoice = state.voice.voices.find((entry) => entry.id === state.voice.configured);
  glance.append(
    row(doc, 'Voice', selectedVoice?.name ?? 'System default', describeVoice(selectedVoice) || undefined),
    row(doc, 'Spoken language', state.voice.language ?? 'Automatic (follow the voice)'),
    row(doc, 'Speech', state.voice.speakResponses ? `On · ${rateLabel(state.voice.speechRate)}` : 'Off'),
    row(
      doc,
      'Wake word',
      state.activation.wakeWord.enabled
        ? `Listening for “${state.activation.wakeWord.phrase}”`
        : 'Off',
      state.activation.wakeWord.available ? undefined : state.activation.wakeWord.reason,
    ),
    row(
      doc,
      'Push to talk',
      `${state.activation.pushToTalk.mode === 'hold' ? 'Hold' : 'Toggle'} · ${state.activation.pushToTalk.globalAccelerator}`,
    ),
    row(doc, 'Accent', accentLabel(state.appearance.accent)),
  );

  const actions = card(doc, 'Quick actions', 'span-2');
  actions.append(
    toggle(
      doc,
      'profile-show-orb',
      'Pin the Orb on screen',
      state.appearance.showOrb,
      true,
      'When off, the Orb appears for a voice turn and dismisses itself afterwards.',
      (next) => {
        void bridge.updateSettings({ showOrb: next }).then(refresh);
      },
    ),
    toggle(
      doc,
      'profile-start-on-login',
      'Start Aria at login',
      state.appearance.startOnLogin,
      signedIn,
      signedIn ? undefined : 'Sign in to change this.',
      (next) => {
        void bridge.updateSettings({ startOnLogin: next }).then(refresh);
      },
    ),
  );
  const openChat = h(doc, 'div', 'control');
  openChat.append(
    button(doc, 'profile-open-chat', 'Open chat', 'primary small', true, () => {
      void bridge.openChat();
    }),
  );
  actions.append(openChat);

  panel.append(identity, glance, actions);
  return panel;
}

function accentLabel(accent: ControlCenterState['appearance']['accent']): string {
  const option = ACCENT_OPTIONS.find((entry) => entry.value === accent);
  return option?.label ?? accent;
}

function ariaConfigPanel(doc: Document, state: ControlCenterState): El {
  const panel = h(doc, 'div', 'panel');
  panel.setAttribute('role', 'tabpanel');
  panel.id = 'panel-ariaConfig';

  const config = card(doc, 'Assistant configuration', 'span-2');
  config.append(
    row(doc, 'Model', state.ariaConfig.model.displayName, 'Reported by this client build; the service does not advertise its model.'),
    row(doc, 'Request timeout', `${state.ariaConfig.requestTimeoutMs} ms`),
    row(
      doc,
      'Microphone device',
      state.ariaConfig.microphoneDeviceId ?? 'System default',
      'Device selection is not wired in this release.',
    ),
    row(
      doc,
      'Speak responses',
      state.voice.speakResponses ? 'On' : 'Off',
      'Change this under Voice & Language.',
    ),
  );

  panel.append(config);
  return panel;
}

function applyAccent(doc: Document, state: ControlCenterState): void {
  const root = doc.documentElement;
  if (state.appearance.accent === 'aurora') {
    root.removeAttribute('data-accent');
    return;
  }
  root.setAttribute('data-accent', state.appearance.accent);
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
  const catalogAvailable = voice.catalogState === 'available';

  panel.append(voiceSummary(doc, state));
  panel.append(voiceStudio(doc, state, bridge, refresh));
  panel.append(voiceControls(doc, state, bridge, refresh, catalogAvailable));
  if (!catalogAvailable) {
    panel.append(
      voiceNotice(
        doc,
        voice.catalogState === 'empty'
          ? 'No voices are available right now.'
          : 'The voice catalog could not be reached.',
        voice.reason ?? 'Voice selection is disabled until the catalog is available.',
      ),
    );
  }
  return panel;
}

function voiceSummary(doc: Document, state: ControlCenterState): El {
  const voice = state.voice;
  const selected = voice.voices.find((entry) => entry.id === voice.configured);
  const wrap = card(doc, 'Now speaking', 'span-2 voice-summary');
  const line = h(doc, 'div', 'voice-hero');

  const orb = h(doc, 'div', 'voice-hero-orb');
  orb.setAttribute('aria-hidden', 'true');
  const meta = h(doc, 'div', 'voice-hero-meta');
  const name = h(doc, 'p', 'voice-hero-name');
  text(name, selected?.name ?? 'System default');
  const sub = h(doc, 'p', 'voice-hero-sub');
  text(sub, describeVoice(selected) || `${voice.language ?? 'Automatic language'} · ${rateLabel(voice.speechRate)}`);
  meta.append(name, sub);

  const chips = h(doc, 'div', 'voice-hero-chips');
  chips.append(
    badge(doc, voice.speakResponses ? 'Speech on' : 'Speech off', voice.speakResponses ? 'ok' : 'neutral'),
    badge(doc, rateLabel(voice.speechRate), 'neutral'),
    ...(voice.language !== undefined ? [badge(doc, voice.language, 'neutral')] : []),
  );
  line.append(orb, meta, chips);
  wrap.append(line);
  return wrap;
}

function voiceStudio(
  doc: Document,
  state: ControlCenterState,
  bridge: ControlCenterBridge,
  refresh: () => void,
): El {
  const voice = state.voice;
  const wrap = card(doc, 'Voice studio', 'span-2 voice-studio');

  if (voice.voices.length === 0) {
    wrap.append(
      emptyState(
        doc,
        'No voices to browse',
        voice.catalogState === 'available'
          ? 'No voices are available right now.'
          : 'Connect to load the voice catalog.',
      ),
    );
    return wrap;
  }

  const genders = unique(voice.voices.map((v) => v.gender).filter(isString));
  const accents = unique(voice.voices.map((v) => v.accent).filter(isString));
  const languages = unique(voice.voices.map((v) => v.language));

  const toolbar = h(doc, 'div', 'studio-toolbar');
  const search = h(doc, 'input', 'studio-search');
  search.type = 'search';
  search.placeholder = 'Search voices, accents, styles…';
  search.setAttribute('aria-label', 'Search voices');
  toolbar.append(search);

  const filters = h(doc, 'div', 'studio-filters');
  filters.append(
    facet(doc, 'language', languages, 'All languages'),
    facet(doc, 'accent', accents, 'All accents'),
    facet(doc, 'gender', genders, 'Any gender'),
  );
  toolbar.append(filters);
  wrap.append(toolbar);

  const grid = h(doc, 'div', 'voice-grid');
  grid.setAttribute('role', 'list');
  const count = h(doc, 'p', 'studio-count');
  wrap.append(grid, count);

  const facetState = { language: '', accent: '', gender: '', query: '' };
  const renderGrid = (): void => {
    const query = facetState.query.trim().toLowerCase();
    const shown = voice.voices.filter((entry) => {
      if (facetState.language !== '' && entry.language !== facetState.language) return false;
      if (facetState.accent !== '' && entry.accent !== facetState.accent) return false;
      if (facetState.gender !== '' && entry.gender !== facetState.gender) return false;
      if (query === '') return true;
      const haystack = [
        entry.name,
        entry.id,
        entry.language,
        entry.accent ?? '',
        entry.gender ?? '',
        entry.description ?? '',
        ...entry.styles,
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });

    count.textContent =
      shown.length === voice.voices.length
        ? `${voice.voices.length} voices`
        : `${shown.length} of ${voice.voices.length} voices`;
    grid.replaceChildren(
      ...(shown.length === 0
        ? [emptyState(doc, 'No matches', 'Try a different search or filter.')]
        : shown.map((entry) => voiceCard(doc, entry, state, bridge, refresh))),
    );
  };

  search.addEventListener('input', () => {
    facetState.query = search.value;
    renderGrid();
  });
  for (const node of Array.from(filters.querySelectorAll('select'))) {
    const select = node as HTMLSelectElement;
    select.addEventListener('change', () => {
      facetState[select.dataset['facet'] as 'language' | 'accent' | 'gender'] = select.value;
      renderGrid();
    });
  }

  renderGrid();
  return wrap;
}

function facet(doc: Document, name: string, values: readonly string[], allLabel: string): El {
  const node = h(doc, 'select', 'studio-facet');
  node.dataset['facet'] = name;
  node.setAttribute('aria-label', `${name} filter`);
  const all = h(doc, 'option');
  all.value = '';
  all.textContent = allLabel;
  node.append(all);
  for (const value of values) {
    const option = h(doc, 'option');
    option.value = value;
    option.textContent = value;
    node.append(option);
  }
  return node;
}

function voiceCard(
  doc: Document,
  entry: VoiceOption,
  state: ControlCenterState,
  bridge: ControlCenterBridge,
  refresh: () => void,
): El {
  const selected = state.voice.configured === entry.id;
  const node = h(doc, 'div', 'voice-card');
  node.setAttribute('role', 'listitem');
  node.setAttribute('data-selected', String(selected));

  const top = h(doc, 'div', 'voice-card-top');
  const avatar = h(doc, 'div', 'voice-avatar');
  avatar.setAttribute('aria-hidden', 'true');
  text(avatar, initials(entry.name));
  const title = h(doc, 'div', 'voice-card-title');
  const name = h(doc, 'p', 'voice-card-name');
  text(name, entry.name);
  const sub = h(doc, 'p', 'voice-card-sub');
  text(sub, describeVoice(entry) || entry.id);
  title.append(name, sub);
  top.append(avatar, title, ...(selected ? [badge(doc, 'Active', 'ok')] : []));
  node.append(top);

  if (entry.description !== undefined) {
    const desc = h(doc, 'p', 'voice-card-desc');
    text(desc, entry.description);
    node.append(desc);
  }

  const tags = h(doc, 'div', 'voice-tags');
  if (entry.gender !== undefined) tags.append(tag(doc, entry.gender));
  if (entry.age !== undefined) tags.append(tag(doc, entry.age));
  if (entry.accent !== undefined) tags.append(tag(doc, entry.accent));
  for (const style of entry.styles) tags.append(tag(doc, style));
  if (entry.sampleRate !== undefined) tags.append(tag(doc, `${Math.round(entry.sampleRate / 1000)} kHz`));
  if (tags.childElementCount > 0) node.append(tags);

  const actions = h(doc, 'div', 'voice-card-actions');
  const canPreview = state.voice.previewAvailable;
  const preview = button(
    doc,
    `preview-${entry.id}`,
    'Preview',
    'ghost small',
    canPreview,
    () => {
      preview.setAttribute('data-busy', 'true');
      text(preview, 'Playing…');
      void bridge
        .previewVoice({
          text: `Hi, I'm ${entry.name}. This is how I sound.`,
          voice: entry.id,
          ...(state.voice.language !== undefined ? { language: state.voice.language } : {}),
          speed: state.voice.speechRate,
        })
        .then((result) => {
          preview.removeAttribute('data-busy');
          text(preview, 'Preview');
          if (!result.ok) preview.setAttribute('title', result.reason ?? 'Preview failed.');
        });
    },
  );
  if (!canPreview) {
    preview.setAttribute('title', state.voice.previewReason ?? 'Voice preview is unavailable.');
  }
  const use = button(
    doc,
    `use-${entry.id}`,
    selected ? 'Selected' : 'Use voice',
    selected ? 'ghost small' : 'primary small',
    !selected,
    () => {
      void bridge.updateSettings({ voice: entry.id, language: entry.language }).then(refresh);
    },
  );
  actions.append(preview, use);
  node.append(actions);
  return node;
}

function voiceControls(
  doc: Document,
  state: ControlCenterState,
  bridge: ControlCenterBridge,
  refresh: () => void,
  catalogAvailable: boolean,
): El {
  const voice = state.voice;
  const wrap = card(doc, 'Output', 'span-2');
  wrap.append(
    hint(
      doc,
      'Choose what Aria speaks with. Changes apply to the next spoken response.',
    ),
  );

  wrap.append(
    toggle(doc, 'speak-responses', 'Speak responses aloud', voice.speakResponses, true, undefined, (next) => {
      void bridge.updateSettings({ speakResponses: next }).then(refresh);
    }),
  );

  const rate = h(doc, 'div', 'control rate-control');
  const rateLabelNode = h(doc, 'span', 'row-label');
  text(rateLabelNode, 'Speech rate');
  const rateValue = h(doc, 'span', 'rate-value');
  text(rateValue, rateLabel(voice.speechRate));
  const slider = h(doc, 'input', 'rate-slider');
  slider.id = 'rate-slider';
  slider.type = 'range';
  slider.min = '0.5';
  slider.max = '2';
  slider.step = '0.05';
  slider.value = String(voice.speechRate);
  slider.setAttribute('aria-label', 'Speech rate');
  slider.addEventListener('input', () => text(rateValue, rateLabel(Number.parseFloat(slider.value))));
  slider.addEventListener('change', () => {
    void bridge.updateSettings({ speechRate: Number.parseFloat(slider.value) }).then(refresh);
  });
  const head = h(doc, 'div', 'rate-head');
  head.append(rateLabelNode, rateValue);
  rate.append(head, slider);
  wrap.append(rate);

  const controls = voice.outputControls;
  const missing: string[] = [];
  if (controls?.pitch !== true) missing.push('pitch');
  if (controls?.volume !== true) missing.push('volume');
  if (controls?.styles !== true) missing.push('style');
  if (missing.length > 0) {
    wrap.append(
      hint(
        doc,
        `Unavailable: ${missing.join(', ')}. Aria does not offer ${
          missing.length === 1 ? 'this control' : 'these controls'
        }, so Aria does not send ${missing.length === 1 ? 'it' : 'them'}.`,
      ),
    );
  }

  const languageOptions = [
    { value: '', label: 'Automatic (follow the voice)' },
    ...(voice.languages.length > 0
      ? voice.languages.map((l) => ({
          value: l.tag,
          label: l.nativeName !== undefined && l.nativeName !== l.name ? `${l.name} · ${l.nativeName}` : l.name,
        }))
      : voice.voices.map((v) => ({ value: v.language, label: v.language })).filter(uniqueByValue)),
  ];
  wrap.append(
    select(
      doc,
      'language-select',
      'Spoken language',
      voice.language ?? '',
      languageOptions,
      true,
      undefined,
      (next) => {
        void bridge.updateSettings({ language: next === '' ? null : next }).then(refresh);
      },
    ),
  );

  if (voice.sttLanguages.length > 0) {
    const recognized = h(doc, 'div', 'control');
    const label = h(doc, 'span', 'row-label');
    text(label, 'Recognized languages');
    const chips = h(doc, 'div', 'voice-tags');
    for (const code of voice.sttLanguages) chips.append(tag(doc, code));
    recognized.append(label, chips);
    wrap.append(recognized);
  }

  if (!catalogAvailable) {
    wrap.append(hint(doc, 'Voice selection re-enables when the catalog is reachable.'));
  }
  return wrap;
}

function voiceNotice(doc: Document, title: string, detail: string): El {
  const wrap = h(doc, 'div', 'voice-notice span-2');
  wrap.setAttribute('role', 'status');
  const heading = h(doc, 'p', 'voice-notice-title');
  text(heading, title);
  const body = h(doc, 'p', 'voice-notice-body');
  text(body, detail);
  wrap.append(heading, body);
  return wrap;
}

function tag(doc: Document, value: string): El {
  const node = h(doc, 'span', 'tag');
  text(node, value);
  return node;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function uniqueByValue(option: { value: string }, index: number, all: readonly { value: string }[]): boolean {
  return all.findIndex((entry) => entry.value === option.value) === index;
}

function isString(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

function describeVoice(entry: VoiceOption | undefined): string {
  if (entry === undefined) return '';
  const parts = [entry.language];
  if (entry.accent !== undefined) parts.push(entry.accent);
  if (entry.gender !== undefined) parts.push(entry.gender);
  return parts.join(' · ');
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).slice(0, 2);
  return words.map((word) => word.charAt(0).toUpperCase()).join('') || '·';
}

function rateLabel(rate: number): string {
  return `${rate.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}×`;
}

function activationPanel(
  doc: Document,
  state: ControlCenterState,
  bridge: ControlCenterBridge,
  refresh: () => void,
): El {
  const panel = h(doc, 'div', 'panel');
  panel.setAttribute('role', 'tabpanel');
  panel.id = 'panel-activation';

  const activation = state.activation;
  const voiceCard = card(doc, 'Voice activation');
  voiceCard.append(
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
  pttKeyRow.append(pttLabel, keys(doc, activation.pushToTalk.key));
  voiceCard.append(pttKeyRow);

  const globalRow = h(doc, 'div', 'row');
  const globalLabel = h(doc, 'span', 'row-label');
  text(globalLabel, 'Global toggle');
  globalRow.append(globalLabel, keys(doc, activation.pushToTalk.globalAccelerator));
  voiceCard.append(globalRow);
  if (!activation.pushToTalk.globalRegistered) {
    // Every candidate was refused; offer a re-grab rather than a dead feature.
    const warn = h(doc, 'p', 'muted reason');
    text(
      warn,
      `No global push-to-talk shortcut could be grabbed (tried ${activation.pushToTalk.globalAccelerator} first); another application holds the combination.`,
    );
    voiceCard.append(
      warn,
      button(doc, 'retry-push-to-talk', 'Retry push-to-talk shortcut', 'ghost small', true, () => {
        void bridge.retryShortcuts().then(refresh);
      }),
    );
  } else {
    const ok = h(doc, 'p', 'muted');
    text(ok, `Registered globally as ${activation.pushToTalk.globalAccelerator}.`);
    voiceCard.append(ok);
  }
  voiceCard.append(
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

  const shortcuts = card(doc, 'Keyboard shortcuts');
  shortcuts.append(
    shortcutControl(
      doc,
      'chat-shortcut-enabled',
      'Open chat',
      activation.chatShortcut.enabled,
      activation.chatShortcut.accelerator,
      (next) => {
        void bridge.updateSettings({ chatShortcutEnabled: next }).then(refresh);
      },
    ),
  );
  if (!activation.chatShortcut.registered) {
    const warn = h(doc, 'p', 'muted reason');
    text(
      warn,
      `Another application holds ${activation.chatShortcut.accelerator}; the chat shortcut is unavailable.`,
    );
    shortcuts.append(
      warn,
      button(doc, 'retry-chat-shortcut', 'Retry chat shortcut', 'ghost small', true, () => {
        void bridge.retryShortcuts().then(refresh);
      }),
    );
  }

  panel.append(voiceCard, shortcuts);
  return panel;
}

function shortcutControl(
  doc: Document,
  id: string,
  label: string,
  checked: boolean,
  accelerator: string,
  onChange: (next: boolean) => void,
): El {
  const line = h(doc, 'label', 'control');
  const input = h(doc, 'input', 'switch-input');
  input.type = 'checkbox';
  input.id = id;
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  const name = h(doc, 'span', 'row-label');
  text(name, label);
  const keysNode = keys(doc, accelerator);
  const knob = h(doc, 'span', 'switch');
  knob.setAttribute('aria-hidden', 'true');
  line.append(input, name, keysNode, knob);
  return line;
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
          'Aria did not answer, so the sign-in state could not be determined.',
      ),
    );
    const actions = h(doc, 'div', 'auth-actions');
    actions.append(button(doc, 'account-retry', 'Retry', 'ghost', true, refresh));
    wrap.append(actions);
    panel.append(wrap);
    return panel;
  }

  wrap.append(
    hint(
      doc,
      'Sign in to use Aria. Aria opens your browser to finish sign-in, then keeps you signed in on this machine.',
    ),
  );
  const actions = h(doc, 'div', 'auth-actions');
  const note = h(doc, 'p', 'auth-note');
  const beyondersButton = button(doc, 'account-beyonders-sign-in', 'Sign in', 'primary', true, () => {
    beyondersButton.disabled = true;
    note.removeAttribute('data-tone');
    text(note, 'Opening your browser…');
    void bridge.beginLogin().then((result) => {
      if (!result.ok) {
        beyondersButton.disabled = false;
        note.setAttribute('data-tone', 'bad');
        text(note, result.reason ?? 'Could not start sign-in.');
        playCue('error');
        return;
      }
      playCue('start');
      text(note, 'Waiting for you to finish in the browser…');
      const waiting = button(doc, 'account-cancel-sign-in', 'Cancel', 'ghost', true, () => {
        void bridge.cancelLogin().then(() => {
          beyondersButton.disabled = false;
          text(note, 'Sign-in cancelled.');
          playCue('stop');
        });
      });
      actions.append(waiting);
      void bridge.awaitLogin().then((awaited) => {
        waiting.remove();
        if (awaited.ok) {
          playCue('confirm');
          refresh();
          return;
        }
        beyondersButton.disabled = false;
        note.setAttribute('data-tone', 'bad');
        text(note, awaited.reason ?? 'Sign-in failed.');
        playCue('error');
      });
    });
  });
  actions.append(beyondersButton);
  wrap.append(actions, note);
  panel.append(wrap);
  return panel;
}

function diagnosticsPanel(doc: Document, state: ControlCenterState): El {
  const panel = h(doc, 'div', 'panel');
  panel.setAttribute('role', 'tabpanel');
  panel.id = 'panel-diagnostics';

  const d = state.diagnostics;
  const backend = card(doc, 'Service');
  const head = backend.querySelector('.card-head');
  head?.append(badge(doc, backendWord(d.backendState), backendTone(d.backendState)));
  backend.append(
    row(doc, 'Reachability', backendWord(d.backendState), d.backendReason),
    row(
      doc,
      'Voice engine',
      d.voiceEngine === 'native' ? 'Renderer capture bound' : 'Unavailable',
      d.voiceEngineReason,
    ),
    row(doc, 'Voice input', d.voiceReady ? 'Ready' : 'Not ready', d.voiceReason),
    row(doc, 'Listening', d.listening ? 'yes' : 'no'),
    row(doc, 'Checked at', d.checkedAt),
  );
  if (d.voiceDetail !== undefined) backend.append(row(doc, 'Detail', d.voiceDetail));

  const errorsCard = card(doc, `Reported errors (${d.incidents.length})`);
  if (d.incidents.length === 0) {
    errorsCard.append(hint(doc, 'No errors have been reported this session.'));
  } else {
    for (const incident of d.incidents) {
      errorsCard.append(row(doc, incident.source, incident.message, incident.at));
    }
  }

  panel.append(backend, errorsCard);
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
  mark.append(brandMark(doc));
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
    tab.tabIndex = id === active ? 0 : -1;
    tab.append(icon(doc, meta.icon));
    const label = h(doc, 'span');
    text(label, meta.label);
    tab.append(label);
    tab.addEventListener('click', () => onSelect(id));
    tab.addEventListener('keydown', (event) => {
      const index = TABS.indexOf(id);
      let next: TabId | undefined;
      if (event.key === 'ArrowDown') next = TABS[(index + 1) % TABS.length];
      else if (event.key === 'ArrowUp') next = TABS[(index - 1 + TABS.length) % TABS.length];
      else if (event.key === 'Home') next = TABS[0];
      else if (event.key === 'End') next = TABS[TABS.length - 1];
      if (next === undefined) return;
      event.preventDefault();
      onSelect(next);
    });
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
  activeTab: TabId = 'profile',
): void {
  const root = doc.getElementById('control-center');
  if (root === null) return;
  const active = doc.activeElement;
  const focusId = active instanceof HTMLElement ? active.id : '';
  root.setAttribute('aria-busy', 'false');
  applyAccent(doc, state);

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
    profile: profilePanel(doc, state, bridge, refresh),
    account: accountPanel(doc, state, bridge, refresh),
    voice: voicePanel(doc, state, bridge, refresh),
    activation: activationPanel(doc, state, bridge, refresh),
    ariaConfig: ariaConfigPanel(doc, state),
    privacy: privacyPanel(doc, state),
    integrations: integrationsPanel(doc, state),
    tasks: tasksPanel(doc, state),
    diagnostics: diagnosticsPanel(doc, state),
    general: generalPanel(doc, state, bridge, refresh),
  };
  for (const id of TABS) {
    panelsToRender[id].setAttribute('data-active', String(id === activeTab));
  }
  panels.replaceChildren(...TABS.map((id) => panelsToRender[id]));

  // A keyboard tab change re-renders the whole tree; keep focus on the newly
  // active tab rather than the stale one, and restore any other focused control.
  if (focusId.startsWith('tab-')) restoreFocus(doc, `tab-${activeTab}`);
  else if (focusId !== '') restoreFocus(doc, focusId);
}

/**
 * Re-focus the element that had focus before a re-render replaced the tree, so
 * an arrow-key tab selection keeps the keyboard on a tab rather than dropping
 * focus to the document.
 */
function restoreFocus(doc: Document, id: string): void {
  const next = doc.getElementById(id);
  if (next === null || !(next instanceof HTMLElement)) return;
  next.focus();
}

export function bootstrapControlCenter(doc: Document, bridge: ControlCenterBridge): void {
  const root = doc.getElementById('control-center');
  // A skeleton, not a blank window, while the first state is fetched.
  if (root !== null) {
    const panels = root.querySelector('.panels');
    if (panels !== null) {
      const skeletons = [0, 1, 2].map(() => {
        const node = doc.createElement('div');
        node.className = 'skeleton block';
        return node;
      });
      panels.replaceChildren(...skeletons);
    }
  }
  const detachCues = attachCues(doc);
  doc.defaultView?.addEventListener('pagehide', detachCues);
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
