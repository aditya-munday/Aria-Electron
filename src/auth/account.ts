/**
 * The account session: a durable Beyonders login on top of the in-memory
 * session token.
 *
 * The token itself still lives in memory (the runtime's `SharedToken`) and is
 * only ever sent as a bearer credential. What persists is the credential file,
 * written on a successful device-code login and read back on the next launch so
 * the user does not have to sign in every time.
 */

import type { Result } from '../backend/result.js';
import { fail, ok } from '../backend/result.js';
import { ariaError } from '../backend/product-errors.js';
import { CredentialStore, type StoredCredential } from './credential-store.js';
import {
  DeviceLoginClient,
  type DeviceLoginClientOptions,
  type LoginPollResult,
  type LoginUser,
} from './device-login.js';
import { deviceFingerprintId } from './fingerprint.js';

export interface BeginLoginResult {
  readonly loginUrl: string;
  readonly expiresAt: string;
  readonly expiresInMs?: number;
}

export interface AccountManagerDeps {
  readonly store?: CredentialStore;
  readonly client?: DeviceLoginClient;
  readonly clientOptions?: DeviceLoginClientOptions;
  readonly fingerprintId?: string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

interface PendingLogin {
  readonly fingerprintId: string;
  readonly fingerprintHash: string;
  readonly expiresAt: string;
  readonly expiresInMs?: number;
  cancelled: boolean;
}

export class AccountManager {
  private readonly store: CredentialStore;
  private readonly client: DeviceLoginClient;
  private readonly fingerprintId: string;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;
  private readonly now: (() => number) | undefined;
  private pending: PendingLogin | undefined;

  constructor(deps: AccountManagerDeps = {}) {
    this.store = deps.store ?? CredentialStore.default();
    this.client = deps.client ?? new DeviceLoginClient(deps.clientOptions ?? {});
    this.fingerprintId = deps.fingerprintId ?? deviceFingerprintId();
    this.sleep = deps.sleep;
    this.now = deps.now;
  }

  /** The persisted token from a previous login, or `undefined` when signed out. */
  restore(): string | undefined {
    return this.store.load()?.authToken;
  }

  /** The stored credential's user fields, for display without a network call. */
  storedUser(): StoredCredential | undefined {
    return this.store.load();
  }

  /** Ask the website for a login URL and remember the code to poll with. */
  async beginLogin(): Promise<Result<BeginLoginResult>> {
    const code = await this.client.requestCode(this.fingerprintId);
    if (!code.ok) return code;
    this.pending = {
      fingerprintId: this.fingerprintId,
      fingerprintHash: code.value.fingerprintHash,
      expiresAt: code.value.expiresAt,
      ...(code.value.expiresInMs !== undefined ? { expiresInMs: code.value.expiresInMs } : {}),
      cancelled: false,
    };
    return ok({
      loginUrl: code.value.loginUrl,
      expiresAt: code.value.expiresAt,
      ...(code.value.expiresInMs !== undefined ? { expiresInMs: code.value.expiresInMs } : {}),
    });
  }

  /**
   * Wait for the browser to finish the flow, then persist the credential. Fails
   * when no login is pending, so a stray poll cannot invent a session.
   */
  async awaitLogin(): Promise<Result<LoginUser>> {
    const pending = this.pending;
    if (pending === undefined) {
      return fail(ariaError('validation', 'No sign-in is in progress.'));
    }
    const result: LoginPollResult = await this.client.poll({
      fingerprintId: pending.fingerprintId,
      fingerprintHash: pending.fingerprintHash,
      expiresAt: pending.expiresAt,
      ...(pending.expiresInMs !== undefined ? { expiresInMs: pending.expiresInMs } : {}),
      shouldContinue: () => !pending.cancelled,
      ...(this.sleep !== undefined ? { sleep: this.sleep } : {}),
      ...(this.now !== undefined ? { now: this.now } : {}),
    });
    this.pending = undefined;
    if (result.status === 'success') {
      this.save(result.user);
      return ok(result.user);
    }
    if (result.status === 'timeout') {
      return fail(ariaError('timeout', 'Sign-in timed out. Please try again.'));
    }
    return fail(ariaError('unauthenticated', 'Sign-in was cancelled.'));
  }

  /** Stop an in-flight poll; the waiting `awaitLogin` resolves as cancelled. */
  cancelLogin(): void {
    if (this.pending !== undefined) this.pending.cancelled = true;
  }

  /** Persist a completed login. */
  save(user: LoginUser): void {
    this.store.save({
      authToken: user.authToken,
      ...(user.id !== undefined ? { id: user.id } : {}),
      ...(user.name !== undefined ? { name: user.name } : {}),
      ...(user.email !== undefined ? { email: user.email } : {}),
      ...(user.fingerprintId !== undefined ? { fingerprintId: user.fingerprintId } : {}),
      ...(user.fingerprintHash !== undefined ? { fingerprintHash: user.fingerprintHash } : {}),
    });
  }

  /** Forget the persisted login. */
  clear(): void {
    this.pending = undefined;
    this.store.clear();
  }

  filePath(): string {
    return this.store.filePath();
  }
}
