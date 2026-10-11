export interface EmergencyStopOutcome {
  readonly engaged: true;
  readonly engagedAt: string;
  readonly localHalt: LocalHaltReport;
}

export interface LocalHaltReport {
  readonly captureHalted: boolean;
  readonly playbackHalted: boolean;
}

export interface SpeechInterruptOutcome {
  readonly interrupted: true;
  readonly at: string;
}

export interface PlaybackStopOutcome {
  readonly stopped: true;
  readonly at: string;
}

export interface StopControllerDeps {
  readonly haltLocal: () => LocalHaltReport;
  readonly interruptLocal?: () => void;
  readonly now?: () => string;
}

export class StopController {
  private readonly deps: StopControllerDeps;
  private readonly now: () => string;
  private engaged = false;
  private lastOutcome: EmergencyStopOutcome | undefined;

  constructor(deps: StopControllerDeps) {
    this.deps = deps;
    this.now = deps.now ?? ((): string => new Date().toISOString());
  }

  isEngaged(): boolean {
    return this.engaged;
  }

  lastEmergencyStop(): EmergencyStopOutcome | undefined {
    return this.lastOutcome;
  }

  engage(): EmergencyStopOutcome {
    this.engaged = true;
    const localHalt = this.deps.haltLocal();
    const outcome: EmergencyStopOutcome = { engaged: true, engagedAt: this.now(), localHalt };
    this.lastOutcome = outcome;
    return outcome;
  }

  release(): void {
    this.engaged = false;
  }

  interruptSpeech(): SpeechInterruptOutcome {
    this.deps.interruptLocal?.();
    return { interrupted: true, at: this.now() };
  }

  stopPlayback(): PlaybackStopOutcome {
    this.deps.interruptLocal?.();
    return { stopped: true, at: this.now() };
  }
}
