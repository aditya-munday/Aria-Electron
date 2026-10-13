import { describe, expect, it } from 'vitest';

import { asVoiceError, isVoiceError, recoveryForVoiceError, VoiceError } from './errors.js';

describe('VoiceError recovery mapping', () => {
  it('maps a denied permission to grant_permission, distinct from a lost device', () => {
    expect(recoveryForVoiceError('permission_denied')).toBe('grant_permission');
    expect(recoveryForVoiceError('device_unavailable')).toBe('select_device');
  });

  it('treats a timeout as an uncertain outcome to reconcile, never a success or failure', () => {
    expect(recoveryForVoiceError('timeout')).toBe('reconcile');
  });

  it('treats a deliberate cancellation as ignorable', () => {
    expect(recoveryForVoiceError('cancelled')).toBe('ignore');
  });
});

describe('VoiceError', () => {
  it('carries the derived recovery and retryability', () => {
    const retryable = new VoiceError('backend_unavailable', 'offline');
    expect(retryable.recovery).toBe('retry');
    expect(retryable.retryable).toBe(true);

    const permanent = new VoiceError('permission_denied', 'no mic');
    expect(permanent.recovery).toBe('grant_permission');
    expect(permanent.retryable).toBe(false);
  });
});

describe('asVoiceError', () => {
  it('returns a real VoiceError unchanged', () => {
    const original = new VoiceError('capture_failed', 'boom');
    expect(asVoiceError(original)).toBe(original);
  });

  it('coerces an unknown throw, preserving the message and defaulting the kind', () => {
    const coerced = asVoiceError(new Error('underlying'));
    expect(isVoiceError(coerced)).toBe(true);
    expect(coerced.kind).toBe('internal');
    expect(coerced.message).toBe('underlying');
  });

  it('uses a safe fallback message for a non-Error throw', () => {
    const coerced = asVoiceError('nope', 'device_unavailable');
    expect(coerced.kind).toBe('device_unavailable');
    expect(coerced.message).toBe('The voice operation failed.');
  });
});
