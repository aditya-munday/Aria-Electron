import { recoveryForError, type AriaErrorKind } from '../backend/product-errors.js';
import { userFacingMessageForKind } from '../backend/user-facing.js';
import type {
  AccountView,
  ActivationView,
  AppearanceView,
  AriaConfigView,
  BackendState,
  CatalogState,
  ControlCenterSources,
  ControlCenterState,
  DiagnosticView,
  IntegrationView,
  PrivacyView,
  SignInState,
  VoiceCatalogEntry,
  VoiceOption,
  VoiceView,
} from './state.js';

const AUTH_KINDS: ReadonlySet<string> = new Set(['no_token', 'unauthenticated']);

const OUTAGE_KINDS: ReadonlySet<string> = new Set([
  'unavailable',
  'timeout',
  'transport',
  'rate_limited',
]);

export function backendStateOf(error: { readonly kind: string }): BackendState {
  return OUTAGE_KINDS.has(error.kind) ? 'outage' : 'unknown';
}

function accountView(sources: ControlCenterSources): AccountView {
  const account = sources.account;
  if (!account.ok) {
    if (account.unauthenticated || AUTH_KINDS.has(account.error.kind)) {
      return { state: 'signed_out' };
    }
    return { state: 'unknown', reason: userFacingMessageForKind(account.error.kind) };
  }
  const identity = account.identity;
  return {
    state: 'signed_in',
    userId: identity.userId,
    ...(identity.email !== undefined && identity.email !== null ? { email: identity.email } : {}),
    roles: identity.roles,
    providers: identity.providers,
    anonymous: identity.anonymous,
  };
}

function voiceView(sources: ControlCenterSources): VoiceView {
  const settings = sources.settings;
  const base = {
    ...(settings.voice !== undefined ? { configured: settings.voice } : {}),
    ...(settings.language !== undefined ? { language: settings.language } : {}),
    speakResponses: settings.speakResponses,
    speechRate: settings.speechRate,
  };

  const capabilities = sources.capabilities;
  if (capabilities.ok) {
    const languages = capabilities.languages ?? [];
    const sttLanguages = capabilities.sttLanguages ?? [];
    const controls =
      capabilities.outputControls !== undefined
        ? { outputControls: capabilities.outputControls }
        : {};
    if (capabilities.voices.length > 0) {
      return {
        ...base,
        ...controls,
        catalogState: 'available',
        voices: capabilities.voices.map(toVoiceOption),
        languages,
        sttLanguages,
      };
    }
    return {
      ...base,
      ...controls,
      catalogState: 'empty',
      voices: [],
      languages,
      sttLanguages,
      reason: 'No voices are available right now.',
    };
  }

  return {
    ...base,
    catalogState: 'unknown',
    voices: [],
    languages: [],
    sttLanguages: [],
    reason: userFacingMessageForKind(capabilities.error.kind),
  };
}

function toVoiceOption(voice: VoiceCatalogEntry): VoiceOption {
  return {
    id: voice.id,
    name: voice.name,
    language: voice.language,
    ...(voice.accent !== undefined ? { accent: voice.accent } : {}),
    ...(voice.gender !== undefined ? { gender: voice.gender } : {}),
    ...(voice.age !== undefined ? { age: voice.age } : {}),
    styles: voice.styles ?? [],
    ...(voice.sampleRate !== undefined ? { sampleRate: voice.sampleRate } : {}),
    ...(voice.description !== undefined ? { description: voice.description } : {}),
  };
}

function activationView(sources: ControlCenterSources): ActivationView {
  const settings = sources.settings;
  const activation = sources.activation;
  return {
    pushToTalk: {
      enabled: settings.pushToTalkEnabled,
      mode: settings.pushToTalkMode,
      key: activation.request,
      globalAccelerator: activation.pushToTalkAccelerator,
      globalRegistered: activation.pushToTalkRegistered,
    },
    wakeWord: {
      enabled: settings.wakeWordEnabled,
      phrase: activation.wakeWordPhrase,
      available: activation.wakeWordAvailable,
      ...(activation.wakeWordReason !== undefined ? { reason: activation.wakeWordReason } : {}),
    },
    chatShortcut: {
      enabled: settings.chatShortcutEnabled,
      accelerator: activation.chatAccelerator,
      registered: activation.chatShortcutRegistered,
    },
  };
}

function ariaConfigView(sources: ControlCenterSources): AriaConfigView {
  const settings = sources.settings;
  const config = sources.config;
  return {
    backendBaseUrl: config.backendBaseUrl,
    requestTimeoutMs: config.requestTimeoutMs,
    model: {
      provider: config.model.provider,
      id: config.model.id,
      displayName: config.model.displayName,
      fixed: true,
    },
    ...(settings.captureDeviceId !== undefined
      ? { microphoneDeviceId: settings.captureDeviceId }
      : {}),
    options: [
      {
        id: 'voice',
        label: 'Synthesis voice',
        value: settings.voice ?? 'System default',
        editable: true,
      },
      {
        id: 'language',
        label: 'Language',
        value: settings.language ?? 'System default',
        editable: true,
      },
      {
        id: 'speakResponses',
        label: 'Speak responses',
        value: settings.speakResponses ? 'On' : 'Off',
        editable: true,
      },
      {
        id: 'speechRate',
        label: 'Speech rate',
        value: `${settings.speechRate.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}×`,
        editable: true,
      },
      {
        id: 'conflictPolicy',
        label: 'Overlapping activations',
        value: 'Cancel the previous turn',
        editable: false,
        reason: 'Fixed by the runtime for this release.',
      },
      {
        id: 'sampleRate',
        label: 'Capture sample rate',
        value: '16000 Hz',
        editable: false,
        reason: 'Set by the voice runtime for this release.',
      },
    ],
  };
}

function privacyView(sources: ControlCenterSources): PrivacyView {
  return {
    tokenStored: 'memory_only',
    historyRetention: 'opted_out',
    historyRetentionEditable: false,
    retentionReason: 'Conversation retention is not available in this release.',
    notes: [
      'Session tokens are held in memory only and are never written to disk.',
      'Task history stores metadata only: status, phase and timestamps.',
      'Conversation text and audio are never persisted locally.',
      `Microphone permission is currently ${sources.microphonePermission}.`,
    ],
  };
}

function integrationView(sources: ControlCenterSources): IntegrationView {
  return sources.integrations;
}

function appearanceView(sources: ControlCenterSources): AppearanceView {
  return {
    accent: sources.settings.accent,
    showOrb: sources.settings.showOrb,
    startOnLogin: sources.settings.startOnLogin,
  };
}

function diagnosticsView(sources: ControlCenterSources): DiagnosticView {
  const account = sources.account;
  const capabilities = sources.capabilities;

  // Reachability is proven by the public capabilities call; a signed-out /me
  // does not mean the Backend is unreachable.
  const backendState: BackendState = capabilities.ok
    ? 'ok'
    : account.ok
      ? 'ok'
      : backendStateOf(capabilities.error);
  const backendReason = capabilities.ok
    ? undefined
    : account.ok
      ? undefined
      : userFacingMessageForKind(capabilities.error.kind);

  const voice = sources.voice;
  const voiceReady =
    sources.microphonePermission === 'granted' && voice.lastErrorKind === undefined;
  const voiceReason =
    voice.lastErrorText ??
    (sources.microphonePermission !== 'granted'
      ? `Microphone permission is ${sources.microphonePermission}.`
      : undefined);
  const voiceDetail = voice.wakeWordFailure;

  return {
    backendState,
    ...(backendReason !== undefined ? { backendReason } : {}),
    voiceReady,
    ...(voiceReason !== undefined ? { voiceReason } : {}),
    ...(voiceDetail !== undefined ? { voiceDetail } : {}),
    voiceEngine: sources.voiceEngine.kind,
    ...(sources.voiceEngine.reason !== undefined
      ? { voiceEngineReason: sources.voiceEngine.reason }
      : {}),
    listening: voice.listening,
    checkedAt: sources.now,
    incidents: sources.incidents,
  };
}

export function assembleControlCenterState(sources: ControlCenterSources): ControlCenterState {
  return {
    generatedAt: sources.now,
    account: accountView(sources),
    voice: voiceView(sources),
    activation: activationView(sources),
    ariaConfig: ariaConfigView(sources),
    privacy: privacyView(sources),
    integrations: integrationView(sources),
    appearance: appearanceView(sources),
    diagnostics: diagnosticsView(sources),
    tasks: sources.tasks,
  };
}

export function recoveryLabel(kind: string): string {
  return recoveryForError(kind as AriaErrorKind);
}

export function catalogStateFromVoices(voices: readonly { readonly id: string }[]): CatalogState {
  return voices.length > 0 ? 'available' : 'empty';
}

export function signInLabel(state: SignInState): string {
  switch (state) {
    case 'signed_in':
      return 'Signed in';
    case 'signed_out':
      return 'Not signed in';
    case 'unknown':
      return 'Sign-in state unknown';
  }
}
