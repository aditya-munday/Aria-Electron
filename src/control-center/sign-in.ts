import type { Identity } from '../contract/product-contract.js';
import type { Result } from '../backend/result.js';
import { recoveryForError } from '../backend/product-errors.js';

export type SignInOutcome =
  | { readonly ok: true; readonly signedIn: true; readonly reason?: string }
  | {
      readonly ok: false;
      readonly signedIn: false;
      readonly reason: string;
      readonly recovery?: string;
    };

export interface SignInAccount {
  readonly sessionToken: string | undefined;
  setSessionToken(token: string | undefined): void;
  identity(): Promise<Result<Identity>>;
}

// A token is verified before it counts, and rolled back if the Backend rejects it.
export async function verifySignIn(
  input: unknown,
  account: SignInAccount,
): Promise<SignInOutcome> {
  const token =
    typeof input === 'object' && input !== null
      ? (input as { token?: unknown }).token
      : undefined;
  if (typeof token !== 'string' || token.trim() === '') {
    return {
      ok: false,
      signedIn: false,
      reason: 'Enter your session token to continue.',
      recovery: 'authenticate',
    };
  }

  const previous = account.sessionToken;
  account.setSessionToken(token.trim());
  const identity = await account.identity();
  if (identity.ok) {
    return { ok: true, signedIn: true, reason: `Signed in as ${identity.value.userId}.` };
  }

  account.setSessionToken(previous);
  return {
    ok: false,
    signedIn: false,
    reason: identity.error.message,
    recovery: recoveryForError(identity.error.kind),
  };
}
