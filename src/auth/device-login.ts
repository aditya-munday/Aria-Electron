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
 */

import type { Result } from '../backend/result.js';
import { fail, ok } from '../backend/result.js';
import { ariaError } from '../backend/product-errors.js';

/** Default prod origin of the directioner.com web app that serves the flow. */
export const DIRECTIONER_LOGIN_URL = 'https://directioner.com';

export const DEFAULT_LOGIN_INTERVAL_MS = 5_000;
export const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export interface DeviceLoginClientOptions {
  /** Origin serving `/api/auth/cli/*`; defaults to the directioner.com app. */
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
  | { readonly status: 'aborted' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function classify(status: number, code: string | undefined): Result<never> {
  if (status === 401) return fail(ariaError('unauthenticated', 'Sign-in was not completed.'));
  if (status === 403) return fail(ariaError('forbidden', 'This account may not sign in here.'));
  if (status === 404) return fail(ariaError('not_found', 'The sign-in service was not found.'));
  if (status === 429) return fail(ariaError('rate_limited', 'Too many sign-in attempts; wait and retry.'));
  if (status >= 500) return fail(ariaError('unavailable', 'The sign-in service is unavailable.'));
  if (code !== undefined && code !== '') {
    return fail(ariaError('unprocessable', `Sign-in failed (${code}).`));
  }
  return fail(ariaError('malformed', 'The sign-in service returned an unexpected response.'));
}

export class DeviceLoginClient {
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: DeviceLoginClientOptions = {}) {
    this.base = (options.baseUrl ?? DIRECTIONER_LOGIN_URL).replace(/\/+$/, '');
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
      return classify(response.status, isRecord(body) ? (body['code'] as string) : undefined);
    }
    if (
      !isRecord(body) ||
      typeof body['loginUrl'] !== 'string' ||
      typeof body['fingerprintHash'] !== 'string' ||
      typeof body['expiresAt'] !== 'string'
    ) {
      return fail(ariaError('malformed', 'The sign-in service returned no login URL.'));
    }
    const expiresInMs = body['expiresInMs'];
    return ok({
      loginUrl: body['loginUrl'],
      fingerprintHash: body['fingerprintHash'],
      expiresAt: body['expiresAt'],
      ...(typeof expiresInMs === 'number' && Number.isFinite(expiresInMs) && expiresInMs > 0
        ? { expiresInMs }
        : {}),
    });
  }

  /**
   * Poll until the browser finishes the flow, the deadline passes, or the
   * caller aborts. A transient 401 is the ordinary "not yet" answer; a network
   * error is retried, never treated as success.
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
    },
  ): Promise<LoginPollResult> {
    const intervalMs = options.intervalMs ?? DEFAULT_LOGIN_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? options.expiresInMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const startedAt = now();

    while (true) {
      if (options.shouldContinue !== undefined && !options.shouldContinue()) {
        return { status: 'aborted' };
      }
      if (now() - startedAt >= timeoutMs) return { status: 'timeout' };

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

      if (response.ok) {
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
