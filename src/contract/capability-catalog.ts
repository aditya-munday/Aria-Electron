export const CAPABILITY_CATALOG_VERSION = '1.0.0' as const;

export type Privilege = 'none' | 'user' | 'privileged';
export type ApprovalPolicy = 'never' | 'per_operation' | 'confirm_tier';
export type RiskLevel = 'low' | 'moderate' | 'high';
export type VerificationMode = 'authoritative_result' | 'local_observation' | 'not_applicable';
export type RetryPolicy = 'idempotent' | 'bounded' | 'not_retryable';

export interface CapabilityDescriptor {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly privilege: Privilege;
  readonly approval: ApprovalPolicy;
  readonly risk: RiskLevel;
  readonly sideEffects: readonly string[];
  readonly verification: VerificationMode;
  readonly cancellable: boolean;
  readonly retry: RetryPolicy;
  readonly reversible: boolean;
  readonly recovery: string;
}

export interface CapabilityEntry extends CapabilityDescriptor {
  readonly supported: boolean;
  readonly reason?: string;
}

export interface CapabilityEnvironment {
  readonly voiceEngine: boolean;
  readonly wakeWord: boolean;
  readonly backend: boolean;
  readonly signedIn: boolean;
  readonly platform: string;
}

export const CAPABILITY_CATALOG: readonly CapabilityDescriptor[] = [
  {
    id: 'chat.typed_turn',
    title: 'Typed chat',
    summary: 'Send a typed turn straight to Backend orchestration without touching the microphone.',
    privilege: 'none',
    approval: 'never',
    risk: 'low',
    sideEffects: ['A turn is recorded on the Backend conversation.'],
    verification: 'authoritative_result',
    cancellable: true,
    retry: 'idempotent',
    reversible: false,
    recovery: 'A failed send is reported as unknown and reconciled by status lookup.',
  },
  {
    id: 'voice.push_to_talk',
    title: 'Push to talk',
    summary: 'Hold the push-to-talk key to capture, transcribe and answer without a wake word.',
    privilege: 'none',
    approval: 'never',
    risk: 'low',
    sideEffects: ['Microphone audio is captured while the key is held.'],
    verification: 'authoritative_result',
    cancellable: true,
    retry: 'not_retryable',
    reversible: false,
    recovery: 'Releasing the key finalizes the utterance; a failed turn surfaces the error and stays stoppable.',
  },
  {
    id: 'voice.wake_word',
    title: 'Wake word',
    summary: 'Detect the wake phrase locally, then capture the following utterance.',
    privilege: 'none',
    approval: 'never',
    risk: 'low',
    sideEffects: ['Microphone audio is captured after activation while detection is enabled.'],
    verification: 'local_observation',
    cancellable: true,
    retry: 'not_retryable',
    reversible: false,
    recovery: 'If the detector is unavailable the limitation is shown and push to talk still works.',
  },
  {
    id: 'speech.interrupt',
    title: 'Interrupt speech',
    summary: 'Stop playback immediately without cancelling the underlying task.',
    privilege: 'none',
    approval: 'never',
    risk: 'low',
    sideEffects: [],
    verification: 'local_observation',
    cancellable: false,
    retry: 'idempotent',
    reversible: false,
    recovery: 'Interruption is local and synchronous; it never waits for playback to finish.',
  },
  {
    id: 'capture.mute',
    title: 'Mute microphone',
    summary: 'Suspend capture and wake-word detection without cancelling work.',
    privilege: 'none',
    approval: 'never',
    risk: 'low',
    sideEffects: ['No new audio is captured until unmuted.'],
    verification: 'local_observation',
    cancellable: false,
    retry: 'idempotent',
    reversible: true,
    recovery: 'Unmuting restores the exact prior activation mode.',
  },
  {
    id: 'task.submit',
    title: 'Submit tracked work',
    summary: 'Submit a request as supervised AI-Engineer work through the Backend execution boundary.',
    privilege: 'user',
    approval: 'never',
    risk: 'moderate',
    sideEffects: ['A durable task is created and an execution may start.'],
    verification: 'authoritative_result',
    cancellable: true,
    retry: 'bounded',
    reversible: false,
    recovery: 'An unacknowledged submit is unknown, never assumed; reconcile by status lookup before retrying.',
  },
  {
    id: 'task.approve',
    title: 'Approve a plan',
    summary: 'Authorize one scoped operation against its exact plan version.',
    privilege: 'user',
    approval: 'per_operation',
    risk: 'high',
    sideEffects: ['The approved operation may execute privileged changes.'],
    verification: 'authoritative_result',
    cancellable: false,
    retry: 'not_retryable',
    reversible: false,
    recovery: 'A material plan change forces reassessment; approval never carries over to a new version.',
  },
  {
    id: 'task.cancel',
    title: 'Cancel a task',
    summary: 'Request cancellation of tracked work and report the confirmed outcome.',
    privilege: 'user',
    approval: 'never',
    risk: 'moderate',
    sideEffects: ['The worker is asked to stop; work may already have advanced.'],
    verification: 'authoritative_result',
    cancellable: false,
    retry: 'not_retryable',
    reversible: false,
    recovery: 'A request is not a confirmation; if the worker does not stop, cancellation is reported failed with a reason.',
  },
  {
    id: 'control.emergency_stop',
    title: 'Emergency stop',
    summary: 'Halt capture, playback and in-flight work on an independent local path.',
    privilege: 'user',
    approval: 'never',
    risk: 'moderate',
    sideEffects: ['New work is refused until the stop is released.'],
    verification: 'authoritative_result',
    cancellable: false,
    retry: 'idempotent',
    reversible: true,
    recovery: 'Stop is independent of model inference and the Backend; it reports the actual outcome per task.',
  },
  {
    id: 'desktop.orb_presence',
    title: 'Orb presence',
    summary: 'Show or hide the floating voice surface.',
    privilege: 'none',
    approval: 'never',
    risk: 'low',
    sideEffects: [],
    verification: 'local_observation',
    cancellable: false,
    retry: 'idempotent',
    reversible: true,
    recovery: 'Presence is a local preference and never gates capture.',
  },
  {
    id: 'desktop.autostart',
    title: 'Start on sign-in',
    summary: 'Register an XDG autostart entry so Aria launches with the session.',
    privilege: 'user',
    approval: 'never',
    risk: 'low',
    sideEffects: ['A desktop entry is written under the user config directory.'],
    verification: 'local_observation',
    cancellable: false,
    retry: 'idempotent',
    reversible: true,
    recovery: 'A write failure is reported rather than claimed as applied.',
  },
];

export function resolveCapabilityCatalog(
  env: CapabilityEnvironment,
): readonly CapabilityEntry[] {
  return CAPABILITY_CATALOG.map((descriptor) => support(descriptor, env));
}

function support(descriptor: CapabilityDescriptor, env: CapabilityEnvironment): CapabilityEntry {
  const reason = unsupportedReason(descriptor.id, env);
  return {
    ...descriptor,
    supported: reason === undefined,
    ...(reason !== undefined ? { reason } : {}),
  };
}

function unsupportedReason(id: string, env: CapabilityEnvironment): string | undefined {
  switch (id) {
    case 'voice.push_to_talk':
    case 'speech.interrupt':
      return env.voiceEngine ? undefined : 'This build ships without a bound microphone and speaker.';
    case 'voice.wake_word':
      if (!env.voiceEngine) return 'This build ships without a bound microphone and speaker.';
      return env.wakeWord ? undefined : 'No wake-word detector is available on this build.';
    case 'task.submit':
    case 'task.approve':
    case 'task.cancel':
      if (!env.backend) return 'The Backend is unreachable.';
      return env.signedIn ? undefined : 'Sign in to the Beyonders backend first.';
    case 'desktop.autostart':
      return env.platform === 'linux' ? undefined : 'Autostart is only implemented on Linux.';
    default:
      return undefined;
  }
}
