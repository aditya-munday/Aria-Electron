/**
 * Error classification for the Directioner product surface (`/api/v1`).
 *
 * A failure is reported as *what actually failed*, never collapsed into a
 * generic "backend error". The distinction matters: "authentication expired"
 * and "backend unreachable" have different recoveries, and an uncertain outcome
 * (a dropped connection on a mutating write) must never be mistaken for either
 * success or a definite failure.
 *
 * The HTTP status is authoritative for behaviour; the backend's machine code
 * sharpens the message but never overrides the status. This mirrors the CLI's
 * `classifyError` and the backend's `ErrorCode` vocabulary.
 */

export type AriaErrorKind =
  | 'not_configured'
  | 'no_token'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'validation'
  | 'unprocessable'
  | 'conflict'
  | 'rate_limited'
  | 'unavailable'
  | 'timeout'
  | 'malformed'
  | 'too_large'
  | 'transport'
  /** A device-code expired or was withdrawn; sign-in must restart. */
  | 'expired_code'
  /**
   * The sign-in service is deployed but not configured (a device-code
   * deployment gap), or otherwise cannot serve sign-in. Distinct from a generic
   * outage so the caller can say "sign-in is not available right now" and stop
   * rather than retry in a tight loop.
   */
  | 'sign_in_unavailable';

/**
 * The recovery a caller should attempt, derived from the kind rather than
 * re-derived at each call site so two surfaces cannot disagree.
 */
export type AriaErrorRecovery =
  | 'authenticate' // needs a human sign-in
  | 'retry' // transient; safe to retry a read
  | 'wait' // rate limited; retry after a delay
  | 'reconcile' // outcome uncertain; re-read authoritative state
  | 'report' // surface to the user; no automatic recovery
  | 'stop'; // permanent; do not retry

const ERROR_RECOVERY: Record<AriaErrorKind, AriaErrorRecovery> = {
  not_configured: 'stop',
  no_token: 'authenticate',
  unauthenticated: 'authenticate',
  forbidden: 'stop',
  not_found: 'stop',
  validation: 'stop',
  unprocessable: 'stop',
  conflict: 'reconcile',
  rate_limited: 'wait',
  unavailable: 'retry',
  timeout: 'reconcile',
  malformed: 'report',
  too_large: 'report',
  transport: 'reconcile',
  expired_code: 'authenticate',
  sign_in_unavailable: 'stop',
};

export function recoveryForError(kind: AriaErrorKind): AriaErrorRecovery {
  return ERROR_RECOVERY[kind];
}

export interface AriaBackendError {
  readonly kind: AriaErrorKind;
  /** Human-facing, already safe to display. Never a secret or a raw payload. */
  readonly message: string;
  /** Backend correlation id, for support. Never content. */
  readonly requestId?: string;
  /** Server-provided `Retry-After`, in seconds, when present. */
  readonly retryAfterSecs?: number;
  /**
   * The HTTP status, when the failure came from a response. Optional, but it
   * lets a caller that must distinguish an upstream/provider failure (502) from
   * a backend outage (503) do so without re-deriving it from the kind.
   */
  readonly status?: number;
}

export function ariaError(
  kind: AriaErrorKind,
  message: string,
  extra: { requestId?: string; retryAfterSecs?: number; status?: number } = {},
): AriaBackendError {
  return {
    kind,
    message,
    ...(extra.requestId !== undefined ? { requestId: extra.requestId } : {}),
    ...(extra.retryAfterSecs !== undefined
      ? { retryAfterSecs: extra.retryAfterSecs }
      : {}),
    ...(extra.status !== undefined ? { status: extra.status } : {}),
  };
}

export function recoveryOf(error: AriaBackendError): AriaErrorRecovery {
  return recoveryForError(error.kind);
}

/**
 * Whether repeating the *same* request could succeed and is safe to retry.
 *
 * Only read-only requests should consult this. A mutating request is never
 * retried automatically: a timeout or a dropped connection could mean it was
 * already applied, and repeating it could double-apply. The caller reconciles
 * instead.
 */
export function isRetryableRead(error: AriaBackendError): boolean {
  const recovery = recoveryOf(error);
  return recovery === 'retry' || recovery === 'wait';
}

/** Map an HTTP status onto an error kind. */
export function kindForStatus(status: number): AriaErrorKind {
  switch (status) {
    case 400:
      return 'validation';
    case 401:
      return 'unauthenticated';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 410:
      // The device code expired or was withdrawn; the sign-in restarts.
      return 'expired_code';
    case 413:
      return 'too_large';
    case 422:
      return 'unprocessable';
    case 429:
      return 'rate_limited';
    case 408:
    case 425:
      return 'timeout';
    default:
      if (status >= 500 && status < 600) return 'unavailable';
      return 'transport';
  }
}
