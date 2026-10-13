import type { ShellSettings } from '../shell/settings.js';
import type { TaskPhase } from '../supervisor/supervisor.js';

export type OrbPresence =
  | 'hidden'
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'interrupted'
  | 'awaiting_approval'
  | 'awaiting_input'
  | 'task_running'
  | 'recovering'
  | 'error'
  | 'muted';

export type OrbCue =
  | 'none'
  | 'dot'
  | 'waveform'
  | 'pulse'
  | 'bars'
  | 'halt'
  | 'shield'
  | 'question'
  | 'gear'
  | 'restore'
  | 'alert'
  | 'slash';

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

export interface OrbTaskView {
  readonly phase: TaskPhase;
  readonly pendingQuestions: number;
  readonly pendingPlans: number;
  readonly pendingPermissions: number;
}

export interface OrbSources {
  readonly diagnostics: OrbVoiceDiagnostics | undefined;
  readonly captureMuted: boolean;
  readonly task?: OrbTaskView;
  readonly now: string;
}

export const ORB_CUE: Readonly<Record<OrbPresence, OrbCue>> = {
  hidden: 'none',
  idle: 'dot',
  listening: 'waveform',
  thinking: 'pulse',
  speaking: 'bars',
  interrupted: 'halt',
  awaiting_approval: 'shield',
  awaiting_input: 'question',
  task_running: 'gear',
  recovering: 'restore',
  error: 'alert',
  muted: 'slash',
};

export const ORB_LABEL: Readonly<Record<OrbPresence, string>> = {
  hidden: 'Hidden',
  idle: 'Idle',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  interrupted: 'Interrupted',
  awaiting_approval: 'Awaiting approval',
  awaiting_input: 'Needs your input',
  task_running: 'Working',
  recovering: 'Recovering',
  error: 'Error',
  muted: 'Muted',
};

export function isOrbPresence(value: string): value is OrbPresence {
  // Own-property check, not `in`: `in` also matches inherited keys, so a stray
  // "toString" would be accepted as a presence and look up a cue of `undefined`.
  return Object.hasOwn(ORB_CUE, value);
}

export interface OrbEnvironment {
  readonly diagnostics: OrbVoiceDiagnostics | undefined;
  readonly settings: ShellSettings;
  readonly task: OrbTaskView | undefined;
}
