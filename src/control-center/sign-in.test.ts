import { describe, expect, it } from 'vitest';

import { fail, ok } from '../backend/result.js';
import { ariaError } from '../backend/product-errors.js';
import { verifySignIn, type SignInAccount } from './sign-in.js';

function account(overrides: Partial<SignInAccount> = {}): SignInAccount & { token: string | undefined } {
  const state = { token: undefined as string | undefined };
  return {
    get sessionToken(): string | undefined {
      return state.token;
    },
    setSessionToken(token: string | undefined): void {
      state.token = token;
    },
    identity: async () => ok({ userId: 'u-1', email: null, roles: [], providers: [], anonymous: false }),
    ...overrides,
  };
}

describe('verifySignIn', () => {
  it('rejects a blank token without touching the session', async () => {
    const a = account();
    const result = await verifySignIn({ token: '   ' }, a);
    expect(result).toMatchObject({ ok: false, signedIn: false, recovery: 'authenticate' });
    expect(a.sessionToken).toBeUndefined();
  });

  it('rejects a non-string token', async () => {
    const result = await verifySignIn({ token: 42 }, account());
    expect(result.ok).toBe(false);
  });

  it('signs in when the Backend resolves the token', async () => {
    const a = account();
    const result = await verifySignIn({ token: 'good-token' }, a);
    expect(result).toEqual({ ok: true, signedIn: true, reason: 'Signed in as u-1.' });
    expect(a.sessionToken).toBe('good-token');
  });

  it('rolls the token back when the Backend rejects it', async () => {
    const a = account({
      identity: async () => fail(ariaError('unauthenticated', 'The session token was rejected.')),
    });
    a.setSessionToken('previous-token');
    const result = await verifySignIn({ token: 'bad-token' }, a);
    expect(result).toMatchObject({ ok: false, signedIn: false, recovery: 'authenticate' });
    expect(a.sessionToken).toBe('previous-token');
  });

  it('classifies an unreachable Backend as reconcile, not a bad credential', async () => {
    const a = account({
      identity: async () => fail(ariaError('transport', 'The connection dropped.')),
    });
    const result = await verifySignIn({ token: 'tok' }, a);
    expect(result).toMatchObject({ ok: false, recovery: 'reconcile' });
    expect(a.sessionToken).toBeUndefined();
  });
});
