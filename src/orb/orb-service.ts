import { describeTaskPhase, type SupervisionRecord, type TaskPhase } from '../supervisor/supervisor.js';
import { resolvePresence } from './assemble.js';
import { ORB_LABEL, type OrbState, type OrbTaskView, type OrbVoiceDiagnostics } from './state.js';
import type { ShellSettings } from '../shell/settings.js';

export interface OrbRuntime {
  voiceDiagnostics(): OrbVoiceDiagnostics | undefined;
  settings(): ShellSettings;
  records(): readonly SupervisionRecord[];
  orbVisible(): boolean;
}

export interface OrbDeps {
  readonly runtime: OrbRuntime;
  readonly now?: () => string;
}

const PHASE_PRIORITY: readonly TaskPhase[] = [
  'unknown',
  'cancellation_unconfirmed',
  'failed',
  'running',
  'accepted',
];

export function summarizeTask(records: readonly SupervisionRecord[]): OrbTaskView | undefined {
  if (records.length === 0) return undefined;

  let pendingQuestions = 0;
  let pendingPlans = 0;
  let pendingPermissions = 0;
  let phase: TaskPhase | undefined;

  for (const record of records) {
    pendingQuestions += record.pendingQuestions.length;
    pendingPlans += record.pendingPlans.length;
    pendingPermissions += record.pendingPermissions.length;
    phase = higherPriority(phase, describeTaskPhase(record));
  }

  return {
    phase: phase ?? 'not_started',
    pendingQuestions,
    pendingPlans,
    pendingPermissions,
  };
}

function higherPriority(current: TaskPhase | undefined, candidate: TaskPhase): TaskPhase {
  if (current === undefined) return candidate;
  const currentRank = PHASE_PRIORITY.indexOf(current);
  const candidateRank = PHASE_PRIORITY.indexOf(candidate);
  if (candidateRank === -1) return current;
  if (currentRank === -1) return candidate;
  return candidateRank < currentRank ? candidate : current;
}

export class OrbService {
  private readonly deps: OrbDeps;
  private readonly now: () => string;

  constructor(deps: OrbDeps) {
    this.deps = deps;
    this.now = deps.now ?? ((): string => new Date().toISOString());
  }

  buildState(): OrbState {
    const now = this.now();
    const settings = this.deps.runtime.settings();
    const task = summarizeTask(this.deps.runtime.records());
    const presence = this.deps.runtime.orbVisible()
      ? resolvePresence({
          diagnostics: this.deps.runtime.voiceDiagnostics(),
          captureMuted: settings.captureMuted,
          ...(task !== undefined ? { task } : {}),
          now,
        })
      : { presence: 'hidden' as const, cue: 'none' as const, label: ORB_LABEL.hidden, updatedAt: now };
    return { generatedAt: now, presence };
  }
}
