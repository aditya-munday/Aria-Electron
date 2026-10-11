import { resolvePresence } from './assemble.js';
import type { OrbState, OrbVoiceDiagnostics } from './state.js';
import type { ShellSettings } from '../shell/settings.js';

export interface OrbRuntime {
  voiceDiagnostics(): OrbVoiceDiagnostics | undefined;
  settings(): ShellSettings;
}

export interface OrbDeps {
  readonly runtime: OrbRuntime;
  readonly now?: () => string;
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
    return {
      generatedAt: now,
      presence: resolvePresence({
        diagnostics: this.deps.runtime.voiceDiagnostics(),
        captureMuted: settings.captureMuted,
        now,
      }),
    };
  }
}
