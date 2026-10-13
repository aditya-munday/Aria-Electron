import { describe, expect, it } from 'vitest';

import { redactUserDetail, userFacingMessageForKind } from './user-facing.js';

describe('userFacingMessageForKind', () => {
  it('maps a known kind to a plain sentence', () => {
    expect(userFacingMessageForKind('unavailable')).toBe('Aria is temporarily unavailable.');
  });

  it('does not echo an unknown kind', () => {
    expect(userFacingMessageForKind('server_error')).toBe('Something went wrong. Try again.');
  });

  it('never returns the kind string itself for an arbitrary input', () => {
    const message = userFacingMessageForKind('http://internal-host:8080');
    expect(message).not.toContain('internal-host');
    expect(message).toBe('Something went wrong. Try again.');
  });

  it('does not treat an inherited prototype key as a known kind', () => {
    expect(userFacingMessageForKind('constructor')).toBe('Something went wrong. Try again.');
    expect(userFacingMessageForKind('toString')).toBe('Something went wrong. Try again.');
  });
});

describe('redactUserDetail', () => {
  it('replaces a backend URL', () => {
    expect(redactUserDetail('request to https://api.example.internal/v1/voices failed')).toBe(
      'request to the service failed',
    );
  });

  it('replaces a host and port', () => {
    expect(redactUserDetail('could not reach api.directioner.io:8443')).toBe(
      'could not reach the host',
    );
  });

  it('replaces a bare IP address', () => {
    expect(redactUserDetail('connect ECONNREFUSED 10.0.0.4:443')).toBe(
      'connect ECONNREFUSED the host',
    );
  });

  it('replaces a bearer token', () => {
    expect(redactUserDetail('Rejected Bearer abc.def.ghi-123')).toBe('Rejected a credential');
  });

  it('replaces a JWT-shaped token', () => {
    const jwt = `eyJ${'a'.repeat(12)}.payload.signature`;
    expect(redactUserDetail(`token ${jwt} expired`)).toBe('token a credential expired');
  });

  it('replaces an email address', () => {
    expect(redactUserDetail('signed in as ada@example.com')).toBe('signed in as the account');
  });

  it('collapses whitespace and trims', () => {
    expect(redactUserDetail('  spaced   out  ')).toBe('spaced out');
  });

  it('returns a neutral sentence when nothing survives', () => {
    expect(redactUserDetail('   ')).toBe('No further detail is available.');
  });
});
