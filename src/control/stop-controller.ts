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
  /**
   * Synchronous local halt of capture and playback. It must not touch the
   * network or a model; the emergency stop depends on it being local and
   * immediate.
   */
  readonly haltLocal: () => LocalHaltReport;
  /** Interrupt local speech/playback now. Never a task cancellation. */
  readonly interruptLocal?: () => void;
  readonly now?: () => string;
}

/**
 * The always-reachable emergency stop and the local speech/playback controls.
 *
 * Emergency stop engages locally and synchronously: it halts capture and
 * playback without awaiting the network, a model, or a healthy Backend. It is
 * deliberately separate from task cancellation (which is reconciled against the
 * Backend and never assumed), from interrupting speech, and from microphone
 * mute. Engaging the stop never reports a task as stopped — that is the
 * supervisor's confirmed report, read separately.
 */
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

  /**
   * Engage the emergency stop. The local halt happens before this returns and
   * is not conditional on any remote call; a failing Backend cannot prevent it.
   */
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

  /** Interrupt Aria's speech/playback now. It never cancels the underlying task. */
  interruptSpeech(): SpeechInterruptOutcome {
    this.deps.interruptLocal?.();
    return { interrupted: true, at: this.now() };
  }

  /** Stop playback. Distinct from interrupt and from task cancellation. */
  stopPlayback(): PlaybackStopOutcome {
    this.deps.interruptLocal?.();
    return { stopped: true, at: this.now() };
  }
}
