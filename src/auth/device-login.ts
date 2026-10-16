/**
 * The Beyonders device-code sign-in, mirroring the Directioner CLI's wire
 * contract exactly (`/api/auth/cli/code` then `/api/auth/cli/status`). Both the
 * CLI and Aria Desktop drive the same website flow, so the request/response
 * shapes are shared rather than reinvented.
 *
 * `expiresAt` is echoed back byte-for-byte: it is the HMAC input the status
 * endpoint verifies. It is never recomputed from the client clock, which is why
 * the server also sends `expiresInMs` (a duration that does not depend on the
 * user's clock) and why the poll deadline is computed from *that*.
 *
 * Failure modes are surfaced with the backend's own message and correlation id
 * rather than collapsed into a generic "sign-in failed":
 *   - 503 is a deployment gap (no signing secret): reported verbatim, not
 *     retried in a tight loop.
 *   - 429 is rate limiting: backed off with jitter, honouring `Retry-After`.
 *   - 410 is an expired or withdrawn code: the sign-in restarts from step 1.
 */

import type { Result } from '../backend/result.js';
import { fail, ok } from '../backend/result.js';
import { ariaError } from '../backend/product-errors.js';

/** Default prod origin of the Aria backend that serves the flow. */
export const DEFAULT_LOGIN_URL = 'https://api.adityamunday.codes';

/** The poll cadence the reference CLI uses: one status check every 5s. */
export const DEFAULT_LOGIN_INTERVAL_MS = 5_000;
export const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * A 410 means the code expired or was withdrawn; a following poll cannot
 * succeed until a new code is issued, so the caller restarts the flow.
 */
export const LOGIN_EXPIRED_MESSAGE =
  'This sign-in code expired or was withdrawn. Start sign-in again.';

/** The user-facing message for a deployment that cannot serve sign-in at all. */
export const SIGN_IN_UNAVAILABLE_MESSAGE = 'Sign-in is not available right now.';

export interface DeviceLoginClientOptions {
  /** Origin serving `/api/auth/cli/*`; defaults to the Aria backend. */
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface DeviceCode {
  readonly loginUrl: string;
  readonly fingerprintHash: string;
  readonly expiresAt: string;
  /** Server duration of the code's validity; the poll deadline's only source. */
  readonly expiresInMs?: number;
}

export interface LoginUser {
  readonly authToken: string;
  readonly id?: string;
  readonly name?: string;
  readonly email?: string;
  readonly fingerprintId?: string;
  readonly fingerprintHash?: string;
}

export type LoginPollResult =
  | { readonly status: 'success'; readonly user: LoginUser }
  | { readonly status: 'timeout' }
  | { readonly status: 'aborted' }
  /** The code expired or was withdrawn (410, or the deadline passed). */
  | { readonly status: 'expired' }
  /** Rate limited and still backing off; the caller tells the user to wait. */
  | { readonly status: 'rate_limited'; readonly retryAfterMs: number }
  /** The service cannot serve sign-in right now (503 and similar). */
  | { readonly status: 'unavailable'; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ErrorEnvelope {
  readonly code?: string;
  readonly message?: string;
  readonly requestId?: string;
}

/**
 * Read the backend's error envelope (`{ error: { code, message, requestId } }`),
 * falling back to a flat `{ code }` body for older shapes.
 */
function errorEnvelope(body: unknown): ErrorEnvelope {
  if (!isRecord(body)) return {};
  const error = body['error'];
  if (isRecord(error)) {
    return {
      ...(typeof error['code'] === 'string' ? { code: error['code'] } : {}),
      ...(typeof error['message'] === 'string' ? { message: error['message'] } : {}),
      ...(typeof error['requestId'] === 'string' ? { requestId: error['requestId'] } : {}),
    };
  }
  return typeof body['code'] === 'string' ? { code: body['code'] } : {};
}

/** Parse a `Retry-After` header (seconds, or an HTTP date) into milliseconds. */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null || header.trim() === '') return undefined;
  const asNumber = Number(header);
  if (Number.isFinite(asNumber) && asNumber >= 0) return asNumber * 1000;
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return undefined;
}

function classify(status: number, body: unknown, retryAfterSecs: number | undefined): Result<never> {
  const envelope = errorEnvelope(body);
  const withMeta = {
    ...(envelope.requestId !== undefined ? { requestId: envelope.requestId } : {}),
    ...(retryAfterSecs !== undefined ? { retryAfterSecs } : {}),
    status,
  };
  if (status === 401) return fail(ariaError('unauthenticated', 'Sign-in was not completed.', withMeta));
  if (status === 403) return fail(ariaError('forbidden', 'This account may not sign in here.', withMeta));
  if (status === 404) return fail(ariaError('not_found', 'The sign-in service was not found.', withMeta));
  if (status === 410) return fail(ariaError('expired_code', LOGIN_EXPIRED_MESSAGE, withMeta));
  if (status === 429) {
    return fail(
      ariaError('rate_limited', envelope.message ?? 'Too many sign-in attempts; wait and retry.', withMeta),
    );
  }
  if (status === 503) {
    // A deployment gap, not an Aria bug: the backend has no code-binding secret.
    // Keep its message verbatim (it names the missing configuration) and stop.
    return fail(
      ariaError('sign_in_unavailable', envelope.message ?? SIGN_IN_UNAVAILABLE_MESSAGE, withMeta),
    );
  }
  if (status >= 500) {
    return fail(ariaError('unavailable', envelope.message ?? 'The sign-in service is unavailable.', withMeta));
  }
  if (envelope.code !== undefined && envelope.code !== '') {
    return fail(ariaError('unprocessable', envelope.message ?? `Sign-in failed (${envelope.code}).`, withMeta));
  }
  return fail(ariaError('malformed', 'The sign-in service returned an unexpected response.', withMeta));
}

export class DeviceLoginClient {
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: DeviceLoginClientOptions = {}) {
    this.base = (options.baseUrl ?? DEFAULT_LOGIN_URL).replace(/\/+$/, '');
    this.doFetch = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async requestCode(fingerprintId: string): Promise<Result<DeviceCode>> {
    let response: Response;
    try {
      response = await this.call('/api/auth/cli/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ fingerprintId }),
      });
    } catch {
      return fail(ariaError('transport', 'Could not reach the sign-in service.'));
    }
    const body = await this.parse(response);
    if (!response.ok) {
      const retryMs = parseRetryAfterMs(response.headers.get('retry-after'));
      return classify(response.status, body, retryMs !== undefined ? Math.round(retryMs / 1000) : undefined);
    }
    if (!isRecord(body) || typeof body['loginUrl'] !== 'string' || typeof body['fingerprintHash'] !== 'string') {
      return fail(ariaError('malformed', 'The sign-in service returned no login URL.'));
    }
    // `expiresAt` is echoed to the status endpoint verbatim. The contract sends a
    // string; an epoch-ms number is accepted defensively and normalised once.
    const rawExpiresAt = body['expiresAt'];
    const expiresAt =
      typeof rawExpiresAt === 'string'
        ? rawExpiresAt
        : typeof rawExpiresAt === 'number' && Number.isFinite(rawExpiresAt)
          ? new Date(rawExpiresAt).toISOString()
          : undefined;
    if (expiresAt === undefined) {
      return fail(ariaError('malformed', 'The sign-in service returned no expiry.'));
    }
    const expiresInMs = body['expiresInMs'];
    return ok({
      loginUrl: body['loginUrl'],
      fingerprintHash: body['fingerprintHash'],
      expiresAt,
      ...(typeof expiresInMs === 'number' && Number.isFinite(expiresInMs) && expiresInMs > 0
        ? { expiresInMs }
        : {}),
    });
  }

  /**
   * Withdraw a pending code. Best-effort: a failure to withdraw never masks the
   * user's cancellation, so the result is advisory.
   */
  async logout(input: {
    readonly fingerprintId: string;
    readonly fingerprintHash?: string;
  }): Promise<Result<void>> {
    try {
      const response = await this.call('/api/auth/cli/logout', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          fingerprintId: input.fingerprintId,
          ...(input.fingerprintHash !== undefined ? { fingerprintHash: input.fingerprintHash } : {}),
        }),
      });
      if (response.ok) return ok(undefined);
      const body = await this.parse(response);
      return classify(response.status, body, undefined);
    } catch {
      return fail(ariaError('transport', 'Could not reach the sign-in service.'));
    }
  }

  /**
   * Poll until the browser finishes the flow, the deadline passes, the code
   * expires, or the caller aborts.
   *
   * - `{ user: null }` (or any body without `authToken`) is the ordinary "not
   *   yet" answer and keeps polling.
   * - A transient network error is retried, never treated as success.
   * - 429 backs off with jitter (honouring `Retry-After`) and reports through
   *   `onRateLimited`, so the UI can tell the user to wait rather than spin.
   * - 410 stops immediately as `expired`; a following poll cannot succeed.
   * - 503 stops immediately as `unavailable` with the backend's own message.
   */
  async poll(
    options: {
      readonly fingerprintId: string;
      readonly fingerprintHash: string;
      readonly expiresAt: string;
      readonly expiresInMs?: number;
      readonly intervalMs?: number;
      readonly timeoutMs?: number;
      readonly shouldContinue?: () => boolean;
      readonly sleep?: (ms: number) => Promise<void>;
      readonly now?: () => number;
      /** Notified when a 429 forces a wait, with the delay in ms. */
      readonly onRateLimited?: (delayMs: number) => void;
      /** Deterministic jitter in [0, 1); defaults to `Math.random`. */
      readonly jitter?: () => number;
      /** Cap the total back-off before giving the user a 429 answer. */
      readonly maxRateLimitWaitMs?: number;
    },
  ): Promise<LoginPollResult> {
    const intervalMs = options.intervalMs ?? DEFAULT_LOGIN_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? options.expiresInMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const jitter = options.jitter ?? Math.random;
    const maxRateLimitWaitMs = options.maxRateLimitWaitMs ?? Math.min(timeoutMs, 60_000);
    const startedAt = now();
    let rateLimitWaitMs = 0;
    let rateLimitStreak = 0;

    // The deadline is measured from the server's `expiresInMs` duration, never
    // from `expiresAt`: the latter is verified by the server against its own
    // clock, and a skewed client clock must not cut a valid code short.
    const pastDeadline = (): boolean => now() - startedAt >= timeoutMs;

    while (true) {
      if (options.shouldContinue !== undefined && !options.shouldContinue()) {
        return { status: 'aborted' };
      }
      if (pastDeadline()) return { status: 'timeout' };

      let response: Response;
      try {
        const query = new URLSearchParams({
          fingerprintId: options.fingerprintId,
          fingerprintHash: options.fingerprintHash,
          expiresAt: options.expiresAt,
        });
        response = await this.call(`/api/auth/cli/status?${query.toString()}`, {
          method: 'GET',
          headers: { accept: 'application/json' },
        });
      } catch {
        await sleep(intervalMs);
        continue;
      }

      if (response.status === 410) return { status: 'expired' };

      if (response.status === 429) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
        const base = retryAfterMs ?? Math.min(1_000 * 2 ** rateLimitStreak, 15_000);
        const delay = jitteredWait(base, jitter);
        rateLimitStreak += 1;
        if (rateLimitWaitMs + delay > maxRateLimitWaitMs || now() - startedAt + delay >= timeoutMs) {
          return { status: 'rate_limited', retryAfterMs: delay };
        }
        rateLimitWaitMs += delay;
        options.onRateLimited?.(delay);
        await sleep(delay);
        continue;
      }

      if (response.status === 503) {
        const body = await this.parse(response);
        return {
          status: 'unavailable',
          message: errorEnvelope(body).message ?? SIGN_IN_UNAVAILABLE_MESSAGE,
        };
      }

      if (response.ok) {
        // A healthy response clears the back-off streak so a later blip is not
        // punished for an earlier one.
        rateLimitStreak = 0;
        const body = await this.parse(response);
        const user = isRecord(body) ? body['user'] : undefined;
        if (isRecord(user) && typeof user['authToken'] === 'string' && user['authToken'] !== '') {
          return { status: 'success', user: toUser(user, options) };
        }
      } else if (response.status !== 401 && response.status >= 500) {
        // A hard outage is worth a longer pause but is still retried: the user
        // may complete the browser flow while the service recovers.
        await sleep(intervalMs);
        continue;
      }

      await sleep(intervalMs);
    }
  }

  private async call(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.doFetch(`${this.base}${path}`, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async parse(response: Response): Promise<unknown> {
    try {
      const text = await response.text();
      return text === '' ? undefined : JSON.parse(text);
    } catch {
      return undefined;
    }
  }
}

/** Add up to 25% jitter so two clients never retry in lockstep. */
function jitteredWait(baseMs: number, jitter: () => number): number {
  const bounded = Math.max(0, baseMs);
  return Math.round(bounded + bounded * 0.25 * jitter());
}

function toUser(user: Record<string, unknown>, options: { fingerprintId: string; fingerprintHash: string }): LoginUser {
  const str = (key: string): string | undefined =>
    typeof user[key] === 'string' && (user[key] as string) !== '' ? (user[key] as string) : undefined;
  const id = str('id');
  const name = str('name');
  const email = str('email');
  return {
    authToken: user['authToken'] as string,
    ...(id !== undefined ? { id } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(email !== undefined ? { email } : {}),
    fingerprintId: options.fingerprintId,
    fingerprintHash: options.fingerprintHash,
  };
}
