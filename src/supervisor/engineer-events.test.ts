import { describe, expect, it } from 'vitest';

import {
  answerQuestionEvent,
  classifyEngineerEvent,
  permissionDecisionEvent,
  planDecisionEvent,
  requiresUserAttention,
} from './engineer-events.js';
import type { TaskEventDto } from '../contract/product-contract.js';

function event(type: string, payload?: Record<string, unknown>, sequence = 1): TaskEventDto {
  return {
    id: `e${sequence}`,
    taskId: 't1',
    sequence,
    type,
    idempotencyKey: `k${sequence}`,
    ...(payload !== undefined ? { payload } : {}),
    createdAt: '2026-10-10T00:00:00.000Z',
  };
}

describe('classifyEngineerEvent', () => {
  it('classifies a progress update', () => {
    const signal = classifyEngineerEvent(
      event('engineer.progress', { summary: 'planning', percent: 20 }),
    );
    expect(signal).toEqual({ kind: 'progress', summary: 'planning', percent: 20 });
    expect(requiresUserAttention(signal)).toBe(false);
  });

  it('classifies a blocking question as needing the user', () => {
    const signal = classifyEngineerEvent(
      event('engineer.question', {
        questionId: 'q1',
        question: 'Which branch?',
        options: ['main', 'dev'],
      }),
    );
    expect(signal.kind).toBe('question');
    if (signal.kind !== 'question') return;
    expect(signal.blocking).toBe(true);
    expect(requiresUserAttention(signal)).toBe(true);
  });

  it('classifies a plan proposal', () => {
    const signal = classifyEngineerEvent(
      event('engineer.plan_proposed', {
        planId: 'p1',
        planVersion: 2,
        summary: 'add a package',
        operations: [{ capability: 'package.install', summary: 'install jq' }],
      }),
    );
    expect(signal.kind).toBe('plan_proposed');
    if (signal.kind !== 'plan_proposed') return;
    expect(signal.planVersion).toBe(2);
    expect(signal.operations).toHaveLength(1);
    expect(requiresUserAttention(signal)).toBe(true);
  });

  it('classifies a permission request as needing the user', () => {
    const signal = classifyEngineerEvent(
      event('engineer.permission_requested', {
        requestId: 'r1',
        capability: 'network.configure',
        scope: 'wlan0',
      }),
    );
    expect(signal.kind).toBe('permission_requested');
    if (signal.kind !== 'permission_requested') return;
    expect(signal.requiresInteractiveAuth).toBe(true);
    expect(requiresUserAttention(signal)).toBe(true);
  });

  it('does not act on a malformed payload — it becomes unknown', () => {
    const signal = classifyEngineerEvent(event('engineer.question', { question: 'no id' }));
    expect(signal.kind).toBe('unknown');
  });

  it('treats an unknown event type as unknown', () => {
    const signal = classifyEngineerEvent(event('tool.completed', { step: 'x' }));
    expect(signal.kind).toBe('unknown');
  });
});

describe('user response events', () => {
  it('builds a stable, idempotent answer event', () => {
    const a = answerQuestionEvent('q1', 'main');
    const b = answerQuestionEvent('q1', 'main');
    expect(a.type).toBe('engineer.answer');
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
    expect(a.payload).toEqual({ questionId: 'q1', answer: 'main' });
  });

  it('binds a plan decision to its version', () => {
    const accepted = planDecisionEvent('p1', 2, 'accepted');
    expect(accepted.payload).toEqual({ planId: 'p1', planVersion: 2, decision: 'accepted' });
    // A decision for a different version is a different key.
    expect(planDecisionEvent('p1', 3, 'accepted').idempotencyKey).not.toBe(
      accepted.idempotencyKey,
    );
  });

  it('builds a permission decision event', () => {
    const denied = permissionDecisionEvent('r1', 'denied', 'not needed');
    expect(denied.type).toBe('engineer.permission_decision');
    expect(denied.payload).toEqual({ requestId: 'r1', decision: 'denied', reason: 'not needed' });
  });
});
