import type { AriaConfig } from '../config.js';
import type { CapabilityEntry } from '../contract/capability-catalog.js';
import type { TaskPhase } from '../supervisor/supervisor.js';
import type { AccentTheme, ShellSettings } from '../shell/settings.js';
import type { PushToTalkMode } from '../shell/window.js';

export type BackendState = 'ok' | 'outage' | 'unconfigured' | 'unauthenticated' | 'unknown';

export type SignInState = 'signed_out' | 'signed_in' | 'unknown';

export type CatalogState = 'available' | 'empty' | 'unknown';

export type PermissionState = 'granted' | 'denied' | 'prompt';

export interface AccountView {
  readonly state: SignInState;
  readonly userId?: string;
  readonly email?: string;
  readonly roles?: readonly string[];
  readonly providers?: readonly string[];
  readonly anonymous?: boolean;
  readonly reason?: string;
}

export interface VoiceView {
  readonly catalogState: CatalogState;
  readonly configured?: string;
  readonly language?: string;
  readonly speakResponses: boolean;
  readonly speechRate: number;
  readonly voices: readonly VoiceOption[];
  readonly languages: readonly LanguageOption[];
  readonly sttLanguages: readonly string[];
  readonly reason?: string;
}

export interface VoiceOption {
  readonly id: string;
  readonly name: string;
  readonly language: string;
  readonly accent?: string;
  readonly gender?: string;
  readonly age?: string;
  readonly styles: readonly string[];
  readonly sampleRate?: number;
  readonly description?: string;
}

export interface LanguageOption {
  readonly tag: string;
  readonly name: string;
  readonly nativeName?: string;
}

export interface ActivationView {
  readonly pushToTalk: {
    readonly enabled: boolean;
    readonly mode: PushToTalkMode;
    readonly key: string;
    readonly globalAccelerator: string;
    readonly globalRegistered: boolean;
  };
  readonly wakeWord: {
    readonly enabled: boolean;
    readonly phrase: string;
    readonly available: boolean;
    readonly reason?: string;
  };
  readonly chatShortcut: {
    readonly enabled: boolean;
    readonly accelerator: string;
    readonly registered: boolean;
  };
}

export interface AriaConfigView {
  readonly backendBaseUrl: string;
  readonly requestTimeoutMs: number;
  readonly model: {
    readonly provider: string;
    readonly id: string;
    readonly displayName: string;
    readonly fixed: true;
  };
  readonly microphoneDeviceId?: string;
  readonly options: readonly {
    readonly id: string;
    readonly label: string;
    readonly value: string;
    readonly editable: boolean;
    readonly reason?: string;
  }[];
}

export interface PrivacyView {
  readonly tokenStored: 'memory_only';
  readonly historyRetention: 'opted_out';
  readonly historyRetentionEditable: false;
  readonly retentionReason?: string;
  readonly notes: readonly string[];
}

export interface IntegrationView {
  readonly backend: { readonly state: BackendState; readonly reason?: string };
  readonly aiEngineer: { readonly state: BackendState; readonly reason?: string };
  readonly catalogVersion: string;
  readonly capabilities: readonly CapabilityEntry[];
}

export interface ReportedIncident {
  readonly at: string;
  readonly source: string;
  readonly message: string;
}

export interface AppearanceView {
  readonly accent: AccentTheme;
  readonly showOrb: boolean;
  readonly startOnLogin: boolean;
}

export interface DiagnosticView {
  readonly backendState: BackendState;
  readonly backendReason?: string;
  readonly voiceReady: boolean;
  readonly voiceReason?: string;
  readonly voiceDetail?: string;
  readonly voiceEngine: 'native' | 'unavailable';
  readonly voiceEngineReason?: string;
  readonly listening: boolean;
  readonly checkedAt: string;
  readonly incidents: readonly ReportedIncident[];
}

export interface TaskHistoryItem {
  readonly taskId: string;
  readonly title: string;
  readonly phase: TaskPhase;
  readonly status: string;
  readonly verification: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ControlCenterState {
  readonly generatedAt: string;
  readonly account: AccountView;
  readonly voice: VoiceView;
  readonly activation: ActivationView;
  readonly ariaConfig: AriaConfigView;
  readonly privacy: PrivacyView;
  readonly integrations: IntegrationView;
  readonly appearance: AppearanceView;
  readonly diagnostics: DiagnosticView;
  readonly tasks: readonly TaskHistoryItem[];
}

export interface VoiceCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly language: string;
  readonly accent?: string;
  readonly gender?: string;
  readonly age?: string;
  readonly styles?: readonly string[];
  readonly sampleRate?: number;
  readonly description?: string;
}

export interface LanguageCatalogEntry {
  readonly tag: string;
  readonly name: string;
  readonly nativeName?: string;
}

export interface VoiceDiagnosticsView {
  readonly configured?: string;
  readonly wakeWordEnabled: boolean;
  readonly wakeWordStatus: string;
  readonly wakeWordModel?: string;
  readonly wakeWordFailure?: string;
  readonly listening: boolean;
  readonly lastErrorKind?: string;
  readonly lastErrorText?: string;
}

export interface ActivationInputs {
  readonly request: string;
  readonly wakeWordPhrase: string;
  readonly chatAccelerator: string;
  readonly pushToTalkAccelerator: string;
  readonly chatShortcutRegistered: boolean;
  readonly pushToTalkRegistered: boolean;
  readonly wakeWordAvailable: boolean;
  readonly wakeWordReason?: string;
}

export interface ControlCenterSources {
  readonly config: AriaConfig;
  readonly settings: ShellSettings;
  readonly account:
    | {
        readonly ok: true;
        readonly identity: {
          readonly userId: string;
          readonly email?: string | null;
          readonly roles: readonly string[];
          readonly providers: readonly string[];
          readonly anonymous: boolean;
        };
      }
    | {
        readonly ok: false;
        readonly error: { readonly kind: string; readonly message: string };
        readonly unauthenticated: boolean;
      };
  readonly capabilities:
    | {
        readonly ok: true;
        readonly voices: readonly VoiceCatalogEntry[];
        readonly languages?: readonly LanguageCatalogEntry[];
        readonly sttLanguages?: readonly string[];
      }
    | { readonly ok: false; readonly error: { readonly kind: string; readonly message: string } };
  readonly voice: VoiceDiagnosticsView;
  readonly microphonePermission: PermissionState;
  readonly voiceEngine: { readonly kind: 'native' | 'unavailable'; readonly reason?: string };
  readonly integrations: IntegrationView;
  readonly tasks: readonly TaskHistoryItem[];
  readonly activation: ActivationInputs;
  readonly incidents: readonly ReportedIncident[];
  readonly now: string;
}

export interface ShellSettingsPatch {
  readonly wakeWordEnabled?: boolean;
  readonly pushToTalkEnabled?: boolean;
  readonly pushToTalkMode?: PushToTalkMode;
  readonly chatShortcutEnabled?: boolean;
  readonly captureMuted?: boolean;
  readonly showOrb?: boolean;
  readonly startOnLogin?: boolean;
  readonly accent?: AccentTheme;
  readonly voice?: string | null;
  readonly language?: string | null;
  readonly speakResponses?: boolean;
  readonly speechRate?: number;
  readonly captureDeviceId?: string | null;
}

export type SettingsKey = keyof ShellSettingsPatch;

export const EDITABLE_SETTINGS_KEYS: readonly SettingsKey[] = [
  'pushToTalkEnabled',
  'pushToTalkMode',
  'wakeWordEnabled',
  'chatShortcutEnabled',
  'captureMuted',
  'showOrb',
  'startOnLogin',
  'accent',
  'voice',
  'language',
  'speakResponses',
  'speechRate',
  'captureDeviceId',
];

export function isEditableSettingsKey(key: string): key is SettingsKey {
  return (EDITABLE_SETTINGS_KEYS as readonly string[]).includes(key);
}

export function isShellSettingsPatch(value: unknown): value is ShellSettingsPatch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.keys(value).every((key) => isEditableSettingsKey(key));
}
