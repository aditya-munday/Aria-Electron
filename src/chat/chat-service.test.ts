import { describe, expect, it } from 'vitest';

import type { ApprovalDto } from '../contract/product-contract.js';
import { ok } from '../backend/result.js';
import type { OperationDescriptor } from '../supervisor/approval-scope.js';
import type { SupervisionRecord } from '../supervisor/task-store.js';
import { ChatService, type ChatRuntime, type ChatTaskControl } from './chat-service.js';
import type { EmergencyStopView } from './state.js';

const NOW = '2026-01-01T00:00:00.000Z';

const OPERATION: OperationDescriptor = {
  capability: 'deploy.service',
  parameters: { service: 'api' },
  privilege: 'admin',
  riskTier: 'elevated',
  affectedResources: ['service:api'],
};

function record(overrides: Partial<SupervisionRecord> = {}): SupervisionRecord {
  return {
    taskId: 't1',
    title: 'Deploy the API',
    status: 'running',
    version: 1,
    origin: 'aria',
    cancellation: 'none',
    verification: 'unverified',
    lastSequence: 0,
    pendingQuestions: [],
    pendingPermissions: [],
    pendingPlans: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function approval(overrides: Partial<ApprovalDto> = {}): ApprovalDto {
  return {
    id: 'a1',
    taskId: 't1',
    userId: 'u1',
    requestedBy: 'u1',
    decision: null,
    createdAt: NOW,
    ...overrides,
  };
}

interface Harness {
  service: ChatService;
  control: ChatTaskControl;
  actions: string[];
  emergency: EmergencyStopView;
}

function makeService(control: ChatTaskControl, principal = 'u1'): ChatService {
  const runtime: ChatRuntime = { voice: { sendText: async () => ({ text: '' }) }, tasks: control };
  return new ChatService({
    runtime,
    principal: () => principal,
    now: () => NOW,
  });
}

function harness(overrides: Partial<ChatTaskControl> = {}): Harness {
  const actions: string[] = [];
  const emergency: EmergencyStopView = {
    engaged: true,
    stopped: ['t2'],
    cancellationUnconfirmed: ['t3'],
    unknown: [],
    reportedAt: NOW,
  };
  const control: ChatTaskControl = {
    records: () => [record()],
    submit: async (input) => ({
      record: record({ taskId: 't1', title: input.title }),
      approvalId: 'a1',
    }),
    reconcile: async () => undefined,
    approvals: async () => ok([approval()]),
    approvalScope: () => ({
      approvalId: 'a1',
      taskId: 't1',
      principal: 'u1',
      operation: OPERATION,
      planVersion: 1,
      granted: true,
    }),
    rememberApproval: async () => undefined,
    decideApproval: async (taskId, approvalId) => {
      actions.push(`approve:${taskId}:${approvalId}`);
      return record();
    },
    answerQuestion: async (taskId, questionId, answer) => {
      actions.push(`answer:${taskId}:${questionId}:${answer}`);
    },
    decidePlan: async (taskId, plan, decision) => {
      actions.push(`plan:${taskId}:${plan.planId}@${plan.planVersion}:${decision}`);
    },
    decidePermission: async (taskId, requestId, decision) => {
      actions.push(`permission:${taskId}:${requestId}:${decision}`);
    },
    cancel: async (taskId) => {
      actions.push(`cancel:${taskId}`);
      return record();
    },
    emergencyStop: async () => emergency,
    ...overrides,
  };
  return { service: makeService(control), control, actions, emergency };
}

describe('chat state assembly', () => {
  it('shows the pending approval and the task progress', async () => {
    const { service } = harness({
      records: () => [
        record({ progress: { kind: 'progress', summary: 'building', percent: 40 } }),
      ],
    });
    const state = await service.buildState();
    expect(state.tasks).toHaveLength(1);
    const task = state.tasks[0];
    expect(task?.phase).toBeDefined();
    expect(task?.progress).toBe(40);
    expect(task?.approval?.approvalId).toBe('a1');
    expect(task?.approval?.scope.capability).toBe('deploy.service');
  });

  it('surfaces pending questions, plans and permissions', async () => {
    const { service } = harness({
      records: () => [
        record({
          pendingQuestions: [
            {
              kind: 'question',
              questionId: 'q1',
              question: 'Which region?',
              options: ['eu', 'us'],
              blocking: true,
            },
          ],
          pendingPlans: [
            {
              kind: 'plan_proposed',
              planId: 'p1',
              planVersion: 2,
              summary: 'Roll out',
              operations: [{ capability: 'deploy.service' }],
            },
          ],
          pendingPermissions: [
            {
              kind: 'permission_requested',
              requestId: 'r1',
              capability: 'filesystem.write',
              scope: '/srv',
              requiresInteractiveAuth: true,
            },
          ],
        }),
      ],
    });
    const state = await service.buildState();
    const task = state.tasks[0];
    expect(task?.questions[0]?.questionId).toBe('q1');
    expect(task?.plans[0]?.operations).toEqual(['deploy.service']);
    expect(task?.permissions[0]?.requestId).toBe('r1');
  });

  it('orders tasks by most recently updated', async () => {
    const { service } = harness({
      records: () => [
        record({ taskId: 'old', updatedAt: '2026-01-01T00:00:00.000Z' }),
        record({ taskId: 'new', updatedAt: '2026-02-01T00:00:00.000Z' }),
      ],
    });
    const state = await service.buildState();
    expect(state.tasks.map((t) => t.taskId)).toEqual(['new', 'old']);
  });
});

describe('chat typed turns', () => {
  it('records the user turn and forwards the text', async () => {
    const sent: string[] = [];
    const { control } = harness();
    const runtime: ChatRuntime = {
      voice: {
        sendText: async (text) => {
          sent.push(text);
          return { text: '' };
        },
      },
      tasks: control,
    };
    const service = new ChatService({ runtime, principal: () => 'u1', now: () => NOW });
    const result = await service.sendText('  ship it  ');
    expect(result.ok).toBe(true);
    expect(sent).toEqual(['ship it']);
    const state = await service.buildState();
    expect(state.turns[0]?.text).toBe('ship it');
    expect(state.turns[0]?.role).toBe('user');
  });

  it('refuses an empty message without calling the voice runtime', async () => {
    const { service } = harness();
    const result = await service.sendText('   ');
    expect(result.ok).toBe(false);
  });

  it('marks the turn failed when the voice runtime throws', async () => {
    const { control } = harness();
    const runtime: ChatRuntime = {
      voice: {
        sendText: async () => {
          throw new Error('backend unreachable');
        },
      },
      tasks: control,
    };
    const service = new ChatService({ runtime, principal: () => 'u1', now: () => NOW });
    const result = await service.sendText('hello');
    expect(result.ok).toBe(false);
    const state = await service.buildState();
    expect(state.turns[0]?.state).toBe('failed');
    expect(state.turns[0]?.error).toBe('backend unreachable');
  });

  it('refuses typed turns when voice is unavailable', async () => {
    const { control } = harness();
    const service = new ChatService({
      runtime: { voice: undefined, tasks: control },
      principal: () => 'u1',
      now: () => NOW,
    });
    const result = await service.sendText('hello');
    expect(result.ok).toBe(false);
  });

  it('does not submit conversational turns with no confirming route hint', async () => {
    const submitted: unknown[] = [];
    const { control } = harness({
      submit: async (input) => {
        submitted.push(input);
        return { record: record(), approvalId: 'a1' };
      },
    });
    const runtime: ChatRuntime = {
      voice: { sendText: async () => ({ text: 'A chat reply.', route: null }) },
      tasks: control,
    };
    const service = new ChatService({ runtime, principal: () => 'u1', now: () => NOW });
    const result = await service.sendText('what is the status?');
    expect(result.ok).toBe(true);
    expect(result.submittedTaskId).toBeUndefined();
    expect(submitted).toEqual([]);
    const state = await service.buildState();
    expect(state.turns.map((t) => t.role)).toEqual(['user', 'assistant']);
  });

  it('submits a turn as tracked work when the route hint requires confirmation', async () => {
    const approvals: unknown[] = [];
    const { control } = harness({
      submit: async (input) => {
        return { record: record({ taskId: 't9', title: input.title }), approvalId: 'a9' };
      },
      rememberApproval: async (input) => void approvals.push(input),
    });
    const runtime: ChatRuntime = {
      voice: {
        sendText: async () => ({
          text: 'I can do that once approved.',
          route: { capability: 'deploy.service', requires_confirmation: true },
        }),
      },
      tasks: control,
    };
    const service = new ChatService({ runtime, principal: () => 'u1', now: () => NOW });
    const result = await service.sendText('deploy the api');
    expect(result.ok).toBe(true);
    expect(result.submittedTaskId).toBe('t9');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      approvalId: 'a9',
      taskId: 't9',
      operation: { capability: 'deploy.service' },
    });
    const state = await service.buildState();
    expect(state.turns[0]?.submittedTaskId).toBe('t9');
    expect(state.turns[0]?.routeCapability).toBe('deploy.service');
  });

  it('reports a submission refusal without losing the conversed turn', async () => {
    const { control } = harness({
      submit: async () => {
        throw new Error('supervisor offline');
      },
    });
    const runtime: ChatRuntime = {
      voice: {
        sendText: async () => ({
          text: 'Ready to work.',
          route: { capability: 'deploy.service', requires_confirmation: true },
        }),
      },
      tasks: control,
    };
    const service = new ChatService({ runtime, principal: () => 'u1', now: () => NOW });
    const result = await service.sendText('deploy the api');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/supervisor offline/);
    const state = await service.buildState();
    expect(state.turns[0]?.text).toBe('deploy the api');
  });
});

describe('approval decisions', () => {
  const input = {
    approvalId: 'a1',
    taskId: 't1',
    planVersion: 1,
    operation: OPERATION,
    decision: 'approved' as const,
  };

  it('forwards an in-scope approval to the supervisor', async () => {
    const { service, actions } = harness();
    const outcome = await service.decideApproval(input);
    expect(outcome.ok).toBe(true);
    expect(actions).toEqual(['approve:t1:a1']);
  });

  it('refuses a materially changed operation and requires reassessment', async () => {
    const { service, actions } = harness();
    const outcome = await service.decideApproval({
      ...input,
      operation: { ...OPERATION, affectedResources: ['service:web'] },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reassessmentRequired).toBe(true);
    expect(actions).toEqual([]);
  });

  it('refuses an approval for another principal', async () => {
    const { control } = harness();
    const service = makeService(control, 'someone-else');
    const outcome = await service.decideApproval(input);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reassessmentRequired).toBe(true);
  });

  it('refuses a malformed decision without touching the supervisor', async () => {
    const { service, actions } = harness();
    const outcome = await service.decideApproval({ approvalId: 'a1' });
    expect(outcome.ok).toBe(false);
    expect(actions).toEqual([]);
  });

  it('refuses an approval that is no longer pending', async () => {
    const { service } = harness({ approvalScope: () => undefined });
    const outcome = await service.decideApproval(input);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reassessmentRequired).toBe(true);
  });
});

describe('question, plan and permission decisions', () => {
  it('answers a question', async () => {
    const { service, actions } = harness();
    const result = await service.answerQuestion({ taskId: 't1', questionId: 'q1', answer: ' eu ' });
    expect(result.ok).toBe(true);
    expect(actions).toEqual(['answer:t1:q1:eu']);
  });

  it('accepts a plan at an exact version', async () => {
    const { service, actions } = harness();
    const result = await service.decidePlan({
      taskId: 't1',
      planId: 'p1',
      planVersion: 2,
      decision: 'accepted',
    });
    expect(result.ok).toBe(true);
    expect(actions).toEqual(['plan:t1:p1@2:accepted']);
  });

  it('decides a permission', async () => {
    const { service, actions } = harness();
    const result = await service.decidePermission({
      taskId: 't1',
      requestId: 'r1',
      decision: 'denied',
    });
    expect(result.ok).toBe(true);
    expect(actions).toEqual(['permission:t1:r1:denied']);
  });

  it('rejects a malformed plan decision', async () => {
    const { service, actions } = harness();
    const result = await service.decidePlan({ taskId: 't1', planId: 'p1' });
    expect(result.ok).toBe(false);
    expect(actions).toEqual([]);
  });
});

describe('cancellation and emergency stop', () => {
  it('requests a cancellation without claiming a confirmed stop', async () => {
    const { service, actions } = harness();
    const result = await service.cancelTask({ taskId: 't1' });
    expect(result.ok).toBe(true);
    expect(actions).toEqual(['cancel:t1']);
    if (result.ok) expect(result.detail).toMatch(/confirmed/);
  });

  it('reports emergency stop results verbatim and caches them on state', async () => {
    const { service, emergency } = harness();
    const report = await service.emergencyStop();
    expect(report).toEqual(emergency);
    const state = await service.buildState();
    expect(state.emergencyStop).toEqual(emergency);
  });
});
