/**
 * The voice runtime's error vocabulary.
 *
 * A voice failure is reported as *what actually failed*, never collapsed into a
 * generic "audio error". The distinction is load-bearing: a denied microphone
 * permission and a disconnected audio device have different recoveries, and a
 * speech request whose outcome is uncertain (a timeout) must never be mistaken
 * for a definite failure or a success.
 *
 * None of these carry audio, transcript text, or a credential; a message is
 * already safe to show a user.
 */

export type VoiceErrorKind =
  // Local audio
  | 'invalid_configuration'
  | 'permission_denied'
  | 'device_unavailable'
  | 'capture_failed'
  | 'unsupported_format'
  | 'malformed_audio'
  // Sessions
  | 'session_conflict'
  // Backend speech proxy
  | 'not_signed_in'
  | 'backend_unavailable'
  | 'speech_rejected'
  | 'speech_failed'
  | 'timeout'
  // Playback
  | 'playback_failed'
  // Control
  | 'cancelled'
  | 'internal';

/**
 * The recovery a caller should attempt, derived from the kind rather than
 * re-derived at each call site so two surfaces cannot disagree.
 */
export type VoiceErrorRecovery =
  | 'grant_permission' // the user must allow microphone access
  | 'select_device' // pick a different device
  | 'retry' // transient; safe to retry
  | 'reconcile' // outcome uncertain; re-read authoritative state
  | 'reconfigure' // the configuration is invalid
  | 'report' // surface to the user; no automatic recovery
  | 'ignore'; // a deliberate cancellation; nothing to do

const RECOVERY: Record<VoiceErrorKind, VoiceErrorRecovery> = {
  invalid_configuration: 'reconfigure',
  permission_denied: 'grant_permission',
  device_unavailable: 'select_device',
  capture_failed: 'retry',
  unsupported_format: 'reconfigure',
  malformed_audio: 'report',
  session_conflict: 'report',
  not_signed_in: 'report',
  backend_unavailable: 'retry',
  speech_rejected: 'report',
  speech_failed: 'retry',
  timeout: 'reconcile',
  playback_failed: 'retry',
  cancelled: 'ignore',
  internal: 'report',
};

export function recoveryForVoiceError(kind: VoiceErrorKind): VoiceErrorRecovery {
  return RECOVERY[kind];
}

export class VoiceError extends Error {
  readonly kind: VoiceErrorKind;
  readonly recovery: VoiceErrorRecovery;
  override readonly cause: unknown;

  constructor(kind: VoiceErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = 'VoiceError';
    this.kind = kind;
    this.recovery = RECOVERY[kind];
    this.cause = cause;
  }

  /** Whether the same operation could succeed if repeated. */
  get retryable(): boolean {
    return this.recovery === 'retry';
  }
}

export function isVoiceError(value: unknown): value is VoiceError {
  return value instanceof VoiceError;
}

/** Coerce any thrown value into a `VoiceError`, preserving a real one. */
export function asVoiceError(value: unknown, fallback: VoiceErrorKind = 'internal'): VoiceError {
  if (isVoiceError(value)) return value;
  const message = value instanceof Error ? value.message : 'The voice operation failed.';
  return new VoiceError(fallback, message, value);
}
