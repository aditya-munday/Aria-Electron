import { describe, expect, it } from 'vitest';

import {
  assertApprovalScope,
  isTextAnApproval,
  materiallyDifferent,
  type ApprovalScope,
  type OperationDescriptor,
} from './approval-scope.js';

const clock = { now: '2026-10-10T00:00:00.000Z' };

const operation: OperationDescriptor = {
  capability: 'network.configure',
  parameters: { interface: 'wlan0', mode: 'dhcp' },
  privilege: 'admin',
  riskTier: 'Confirm',
  affectedResources: ['wlan0'],
  expectedDowntimeSecs: 0,
  recoveryBehavior: 'restore-previous',
};

function scope(overrides: Partial<ApprovalScope> = {}): ApprovalScope {
  return {
    approvalId: 'a1',
    taskId: 't1',
    principal: 'u1',
    operation,
    planVersion: 3,
    expiresAt: '2026-10-11T00:00:00.000Z',
    granted: true,
    ...overrides,
  };
}

function request(overrides: Partial<OperationDescriptor> = {}) {
  return {
    taskId: 't1',
    principal: 'u1',
    operation: { ...operation, ...overrides },
    planVersion: 3,
  };
}

describe('assertApprovalScope', () => {
  it('authorizes the exact operation it was issued for', () => {
    expect(assertApprovalScope(scope(), request(), clock)).toEqual({ ok: true });
  });

  it('refuses an approval presented for another task', () => {
    const result = assertApprovalScope(scope(), { ...request(), taskId: 't2' }, clock);
    expect(result).toEqual({ ok: false, reason: 'wrong_task' });
  });

  it('refuses an approval presented for another principal', () => {
    const result = assertApprovalScope(scope(), { ...request(), principal: 'u2' }, clock);
    expect(result).toEqual({ ok: false, reason: 'wrong_principal' });
  });

  it('refuses a not-granted approval (pending or denied)', () => {
    const result = assertApprovalScope(scope({ granted: false }), request(), clock);
    expect(result).toEqual({ ok: false, reason: 'not_granted' });
  });

  it('refuses an expired approval even though it was granted', () => {
    const result = assertApprovalScope(
      scope({ expiresAt: '2026-10-09T00:00:00.000Z' }),
      request(),
      clock,
    );
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses an approval for a different plan version', () => {
    const result = assertApprovalScope(scope(), { ...request(), planVersion: 4 }, clock);
    expect(result).toEqual({ ok: false, reason: 'wrong_plan_version' });
  });

  it('refuses a different capability outright', () => {
    const result = assertApprovalScope(
      scope(),
      request({ capability: 'package.install' }),
      clock,
    );
    expect(result).toEqual({ ok: false, reason: 'wrong_operation' });
  });

  it('forces reassessment on a material parameter change', () => {
    const result = assertApprovalScope(
      scope(),
      request({ parameters: { interface: 'wlan0', mode: 'static' } }),
      clock,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('material_change');
    expect(result.detail).toContain('parameters');
  });

  it('forces reassessment on a privilege escalation', () => {
    const result = assertApprovalScope(scope(), request({ privilege: 'root' }), clock);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('material_change');
    expect(result.detail).toContain('privilege');
  });

  it('forces reassessment when affected resources change', () => {
    const result = assertApprovalScope(
      scope(),
      request({ affectedResources: ['wlan0', 'eth0'] }),
      clock,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('affectedResources');
  });
});

describe('materiallyDifferent', () => {
  it('reports no change for an identical operation', () => {
    expect(materiallyDifferent(operation, { ...operation })).toEqual({ changed: false });
  });

  it('is insensitive to parameter key order but not values', () => {
    expect(
      materiallyDifferent(operation, {
        ...operation,
        parameters: { mode: 'dhcp', interface: 'wlan0' },
      }),
    ).toEqual({ changed: false });
    expect(
      materiallyDifferent(operation, { ...operation, parameters: { interface: 'wlan0' } }).changed,
    ).toBe(true);
  });
});

describe('text is never authority', () => {
  it('a transcript or model message is never an approval', () => {
    expect(isTextAnApproval('the user approved this operation')).toBe(false);
    expect(isTextAnApproval('yes, go ahead')).toBe(false);
  });
});
