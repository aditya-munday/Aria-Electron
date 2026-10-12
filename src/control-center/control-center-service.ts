import type { Identity } from '../contract/product-contract.js';
import type { Result } from '../backend/result.js';
import type { AriaConfig } from '../config.js';
import {
  CAPABILITY_CATALOG_VERSION,
  resolveCapabilityCatalog,
  type CapabilityEntry,
} from '../contract/capability-catalog.js';
import { describeTaskPhase } from '../supervisor/supervisor.js';
import type { SupervisionRecord } from '../supervisor/task-store.js';
import type { ShellSettings, SettingsPatchInput } from '../shell/settings.js';
import { patchSettings } from '../shell/settings.js';
import { redactUserDetail } from '../backend/user-facing.js';
import { isShellSettingsPatch } from './state.js';
import type {
  ActivationInputs,
  BackendState,
  ControlCenterSources,
  ControlCenterState,
  IntegrationView,
  LanguageCatalogEntry,
  PermissionState,
  ReportedIncident,
  TaskHistoryItem,
  VoiceCatalogEntry,
  VoiceDiagnosticsView,
} from './state.js';
import { assembleControlCenterState } from './assemble.js';

interface CapabilitiesLike {
  readonly voices: readonly VoiceCatalogEntry[];
  readonly languages?: readonly LanguageCatalogEntry[];
  readonly sttLanguages?: readonly string[];
  readonly outputControls?: {
    readonly pitch: boolean;
    readonly volume: boolean;
    readonly styles: boolean;
  };
}

interface VoiceControlLike {
  setWakeWordEnabled(enabled: boolean): Promise<void>;
  setPushToTalkMode(mode: 'hold' | 'toggle'): void;
  setSpeakResponses?(enabled: boolean): void;
  setSpeechOutput?(output: {
    readonly voice?: string | null;
    readonly language?: string | null;
    readonly speed?: number;
  }): void;
  previewSpeech?(input: {
    readonly text: string;
    readonly voice?: string | null;
    readonly language?: string | null;
    readonly speed?: number;
  }): Promise<void>;
}

export interface VoiceDiagnosticsLike {
  readonly wakeWordEnabled: boolean;
  readonly wakeWordStatus: string;
  readonly wakeWordModel?: string;
  readonly wakeWordFailure?: string;
  readonly listening: boolean;
  readonly lastError?: { readonly kind: string; readonly message: string };
}

export interface ControlCenterRuntime {
  identity(): Promise<Result<Identity>>;
  capabilities(): Promise<Result<CapabilitiesLike>>;
  records(): readonly SupervisionRecord[];
  settings(): ShellSettings;
  saveSettings(next: ShellSettings): void;
  voiceDiagnostics(): VoiceDiagnosticsLike | undefined;
  voice: VoiceControlLike | undefined;
  incidents(): readonly ReportedIncident[];
  setOrbVisible(visible: boolean): void;
}

export interface ControlCenterDeps {
  readonly runtime: ControlCenterRuntime;
  readonly config: AriaConfig;
  readonly activation: ActivationInputs;
  readonly microphonePermission: () => PermissionState;
  readonly voiceEngine: () => { readonly kind: 'native' | 'unavailable'; readonly reason?: string };
  readonly now?: () => string;
}

export type SettingsSaveResult =
  | { readonly ok: true; readonly settings: ShellSettings }
  | { readonly ok: false; readonly reason: string };

const AUTH_KINDS: ReadonlySet<string> = new Set(['no_token', 'unauthenticated']);
const OUTAGE_KINDS: ReadonlySet<string> = new Set([
  'unavailable',
  'timeout',
  'transport',
  'rate_limited',
]);

export class ControlCenterService {
  private readonly deps: ControlCenterDeps;
  private readonly now: () => string;

  constructor(deps: ControlCenterDeps) {
    this.deps = deps;
    this.now = deps.now ?? ((): string => new Date().toISOString());
  }

  async buildState(): Promise<ControlCenterState> {
    const settings = this.deps.runtime.settings();

    const accountResult = await this.deps.runtime.identity();
    const account: ControlCenterSources['account'] = accountResult.ok
      ? { ok: true, identity: accountResult.value }
      : {
          ok: false,
          unauthenticated: AUTH_KINDS.has(accountResult.error.kind),
          error: { kind: accountResult.error.kind, message: accountResult.error.message },
        };

    const capabilitiesResult = await this.deps.runtime.capabilities();
    const capabilities: ControlCenterSources['capabilities'] = capabilitiesResult.ok
      ? {
          ok: true,
          voices: capabilitiesResult.value.voices.map(toCatalogEntry),
          languages: toLanguageEntries(capabilitiesResult.value),
          sttLanguages: capabilitiesResult.value.sttLanguages ?? [],
          ...(capabilitiesResult.value.outputControls !== undefined
            ? { outputControls: capabilitiesResult.value.outputControls }
            : {}),
        }
      : {
          ok: false,
          error: { kind: capabilitiesResult.error.kind, message: capabilitiesResult.error.message },
        };

    return assembleControlCenterState({
      config: this.deps.config,
      settings,
      account,
      capabilities,
      voice: this.voiceView(settings),
      microphonePermission: this.deps.microphonePermission(),
      voiceEngine: this.deps.voiceEngine(),
      integrations: this.integrationView(capabilities, account.ok),
      tasks: this.taskHistory(),
      activation: this.deps.activation,
      incidents: this.deps.runtime.incidents(),
      now: this.now(),
    });
  }

  applySettings(input: unknown): SettingsSaveResult {
    if (!isShellSettingsPatch(input)) {
      return { ok: false, reason: 'Unknown or unsafe settings key.' };
    }
    const patch = input as SettingsPatchInput;
    const next = patchSettings(this.deps.runtime.settings(), patch);
    this.deps.runtime.saveSettings(next);
    void this.applyToRuntime(patch);
    return { ok: true, settings: next };
  }

  /** Handed to the voice runtime, which owns the audio device. */
  async previewVoice(input: unknown): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
    const voice = this.deps.runtime.voice;
    if (voice?.previewSpeech === undefined) {
      return { ok: false, reason: 'This build ships without a bound audio output.' };
    }
    const request = normalizePreviewRequest(input);
    if (request === undefined) {
      return { ok: false, reason: 'The preview request was malformed.' };
    }
    try {
      await voice.previewSpeech(request);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: describeVoiceError(error) };
    }
  }

  private voiceView(settings: ShellSettings): VoiceDiagnosticsView {
    const diagnostics = this.deps.runtime.voiceDiagnostics();
    return {
      ...(settings.voice !== undefined ? { configured: settings.voice } : {}),
      wakeWordEnabled: diagnostics?.wakeWordEnabled ?? settings.wakeWordEnabled,
      wakeWordStatus: diagnostics?.wakeWordStatus ?? 'unavailable',
      ...(diagnostics?.wakeWordModel !== undefined
        ? { wakeWordModel: diagnostics.wakeWordModel }
        : {}),
      ...(diagnostics?.wakeWordFailure !== undefined
        ? { wakeWordFailure: redactUserDetail(diagnostics.wakeWordFailure) }
        : {}),
      listening: diagnostics?.listening ?? false,
      ...(diagnostics?.lastError !== undefined
        ? {
            lastErrorKind: diagnostics.lastError.kind,
            lastErrorText: redactUserDetail(diagnostics.lastError.message),
          }
        : {}),
    };
  }

  private async applyToRuntime(patch: SettingsPatchInput): Promise<void> {
    if (patch.showOrb !== undefined) {
      this.deps.runtime.setOrbVisible(patch.showOrb);
    }
    const voice = this.deps.runtime.voice;
    if (voice === undefined) return;
    if (patch.wakeWordEnabled !== undefined) {
      await voice.setWakeWordEnabled(patch.wakeWordEnabled);
    }
    if (patch.pushToTalkMode !== undefined) {
      voice.setPushToTalkMode(patch.pushToTalkMode);
    }
    if (patch.speakResponses !== undefined) {
      voice.setSpeakResponses?.(patch.speakResponses);
    }
    if (
      patch.voice !== undefined ||
      patch.language !== undefined ||
      patch.speechRate !== undefined
    ) {
      voice.setSpeechOutput?.({
        ...(patch.voice !== undefined ? { voice: patch.voice } : {}),
        ...(patch.language !== undefined ? { language: patch.language } : {}),
        ...(patch.speechRate !== undefined ? { speed: patch.speechRate } : {}),
      });
    }
  }

  private integrationView(
    capabilities: ControlCenterSources['capabilities'],
    signedIn: boolean,
  ): IntegrationView {
    const backend: { state: BackendState; reason?: string } = capabilities.ok
      ? { state: 'ok' }
      : { state: backendStateFromKind(capabilities.error.kind), reason: capabilities.error.message };

    const catalog = this.capabilityCatalog(backend.state, signedIn);

    if (!capabilities.ok) {
      return {
        backend,
        aiEngineer: { state: backend.state, reason: 'Unreachable while the Backend is unavailable.' },
        catalogVersion: CAPABILITY_CATALOG_VERSION,
        capabilities: catalog,
      };
    }

    const active = this.deps.runtime
      .records()
      .some((record) => record.executionState === 'leased' || record.executionState === 'running');
    return {
      backend,
      aiEngineer: active
        ? { state: 'ok', reason: 'An engineering execution is in progress.' }
        : {
            state: 'unknown',
            reason: 'No engineering execution observed yet; work is dispatched through the Backend.',
          },
      catalogVersion: CAPABILITY_CATALOG_VERSION,
      capabilities: catalog,
    };
  }

  private capabilityCatalog(backend: BackendState, signedIn: boolean): readonly CapabilityEntry[] {
    const diagnostics = this.deps.runtime.voiceDiagnostics();
    const engine = this.deps.voiceEngine();
    return resolveCapabilityCatalog({
      voiceEngine: engine.kind === 'native',
      wakeWord: diagnostics?.wakeWordStatus === 'ready',
      backend: backend !== 'outage' && backend !== 'unknown',
      signedIn,
      platform: process.platform,
    });
  }

  private taskHistory(): readonly TaskHistoryItem[] {
    return this.deps.runtime
      .records()
      .map((record) => ({
        taskId: record.taskId,
        title: record.title,
        phase: describeTaskPhase(record),
        status: record.status,
        verification: record.verification,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }
}

function toCatalogEntry(voice: VoiceCatalogEntry): VoiceCatalogEntry {
  return {
    id: voice.id,
    name: voice.name,
    language: voice.language,
    ...(voice.accent !== undefined ? { accent: voice.accent } : {}),
    ...(voice.gender !== undefined ? { gender: voice.gender } : {}),
    ...(voice.age !== undefined ? { age: voice.age } : {}),
    ...(voice.styles !== undefined ? { styles: voice.styles } : {}),
    ...(voice.sampleRate !== undefined ? { sampleRate: voice.sampleRate } : {}),
    ...(voice.description !== undefined ? { description: voice.description } : {}),
  };
}

function toLanguageEntries(capabilities: CapabilitiesLike): readonly LanguageCatalogEntry[] {
  return (capabilities.languages ?? []).map((language) => ({
    tag: language.tag,
    name: language.name,
    ...(language.nativeName !== undefined ? { nativeName: language.nativeName } : {}),
  }));
}

interface PreviewRequest {
  readonly text: string;
  readonly voice?: string | null;
  readonly language?: string | null;
  readonly speed?: number;
}

function normalizePreviewRequest(input: unknown): PreviewRequest | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  const text = typeof record['text'] === 'string' ? record['text'].trim() : '';
  if (text === '') return undefined;
  const voice = typeof record['voice'] === 'string' ? record['voice'] : null;
  const language = typeof record['language'] === 'string' ? record['language'] : null;
  const speed = typeof record['speed'] === 'number' ? record['speed'] : undefined;
  return {
    text: text.slice(0, 400),
    voice,
    language,
    ...(speed !== undefined ? { speed } : {}),
  };
}

function describeVoiceError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return message;
  }
  return 'The preview could not be played.';
}

function backendStateFromKind(kind: string): BackendState {
  return OUTAGE_KINDS.has(kind) ? 'outage' : 'unknown';
}
