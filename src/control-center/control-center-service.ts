import type { Identity } from '../contract/product-contract.js';
import type { Result } from '../backend/result.js';
import type { AriaConfig } from '../config.js';
import { describeTaskPhase } from '../supervisor/supervisor.js';
import type { SupervisionRecord } from '../supervisor/task-store.js';
import type { ShellSettings, SettingsPatchInput } from '../shell/settings.js';
import { patchSettings } from '../shell/settings.js';
import { isShellSettingsPatch } from './state.js';
import type {
  ActivationInputs,
  BackendState,
  ControlCenterSources,
  ControlCenterState,
  IntegrationView,
  PermissionState,
  TaskHistoryItem,
  VoiceCatalogEntry,
  VoiceDiagnosticsView,
} from './state.js';
import { assembleControlCenterState } from './assemble.js';

interface CapabilitiesLike {
  readonly voices: readonly VoiceCatalogEntry[];
}

interface VoiceControlLike {
  setWakeWordEnabled(enabled: boolean): Promise<void>;
  setPushToTalkMode(mode: 'hold' | 'toggle'): void;
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
}

export interface ControlCenterDeps {
  readonly runtime: ControlCenterRuntime;
  readonly config: AriaConfig;
  readonly activation: ActivationInputs;
  readonly microphonePermission: () => PermissionState;
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
      ? { ok: true, voices: capabilitiesResult.value.voices.map(toCatalogEntry) }
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
      integrations: this.integrationView(capabilities),
      tasks: this.taskHistory(),
      activation: this.deps.activation,
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
        ? { wakeWordFailure: diagnostics.wakeWordFailure }
        : {}),
      listening: diagnostics?.listening ?? false,
      ...(diagnostics?.lastError !== undefined
        ? { lastErrorKind: diagnostics.lastError.kind, lastErrorText: diagnostics.lastError.message }
        : {}),
    };
  }

  private async applyToRuntime(patch: SettingsPatchInput): Promise<void> {
    const voice = this.deps.runtime.voice;
    if (voice === undefined) return;
    if (patch.wakeWordEnabled !== undefined) {
      await voice.setWakeWordEnabled(patch.wakeWordEnabled);
    }
    if (patch.pushToTalkMode !== undefined) {
      voice.setPushToTalkMode(patch.pushToTalkMode);
    }
  }

  private integrationView(capabilities: ControlCenterSources['capabilities']): IntegrationView {
    const backend: { state: BackendState; reason?: string } = capabilities.ok
      ? { state: 'ok' }
      : { state: backendStateFromKind(capabilities.error.kind), reason: capabilities.error.message };

    if (!capabilities.ok) {
      return {
        backend,
        aiEngineer: { state: backend.state, reason: 'Unreachable while the Backend is unavailable.' },
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
    };
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
  return { id: voice.id, name: voice.name, language: voice.language };
}

function backendStateFromKind(kind: string): BackendState {
  return OUTAGE_KINDS.has(kind) ? 'outage' : 'unknown';
}
