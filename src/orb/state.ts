import type { ShellSettings } from '../shell/settings.js';

export type OrbPresence = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error' | 'muted';

export type OrbCue = 'dot' | 'waveform' | 'pulse' | 'bars' | 'alert' | 'slash';

export interface OrbPresenceView {
  readonly presence: OrbPresence;
  readonly cue: OrbCue;
  readonly label: string;
  readonly detail?: string;
  readonly updatedAt: string;
}

export interface OrbState {
  readonly generatedAt: string;
  readonly presence: OrbPresenceView;
}

export interface OrbVoiceDiagnostics {
  readonly listening: boolean;
  readonly sessionState: string;
  readonly wakeWordEnabled: boolean;
  readonly lastError?: { readonly kind: string; readonly message: string };
}

export interface OrbSources {
  readonly diagnostics: OrbVoiceDiagnostics | undefined;
  readonly captureMuted: boolean;
  readonly now: string;
}

export const ORB_CUE: Readonly<Record<OrbPresence, OrbCue>> = {
  idle: 'dot',
  listening: 'waveform',
  thinking: 'pulse',
  speaking: 'bars',
  error: 'alert',
  muted: 'slash',
};

export const ORB_LABEL: Readonly<Record<OrbPresence, string>> = {
  idle: 'Idle',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  error: 'Error',
  muted: 'Muted',
};

export function isOrbPresence(value: string): value is OrbPresence {
  return value in ORB_CUE;
}

export interface OrbEnvironment {
  readonly diagnostics: OrbVoiceDiagnostics | undefined;
  readonly settings: ShellSettings;
}
