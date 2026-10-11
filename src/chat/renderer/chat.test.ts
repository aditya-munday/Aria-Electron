// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { renderChat, type ChatBridge } from './chat.js';
import type { ChatActionResult, ChatState, EmergencyStopView } from '../state.js';

const NOW = '2026-01-01T00:00:00.000Z';

function approvalTask(): ChatState {
  return {
    generatedAt: NOW,
    turns: [],
    tasks: [
      {
        taskId: 't1',
        title: 'Deploy the API',
        phase: 'awaiting_approval',
        status: 'awaiting_approval',
        approval: {
          approvalId: 'a1',
          taskId: 't1',
          requestedBy: 'u1',
          createdAt: NOW,
          decision: null,
          scope: {
            capability: 'deploy.service',
            riskTier: 'elevated',
            planVersion: 3,
            affectedResources: ['service:api'],
          },
        },
        questions: [],
        plans: [],
        permissions: [],
        updatedAt: NOW,
      },
    ],
  };
}

interface Recorder {
  bridge: ChatBridge;
  approvals: unknown[];
  answers: unknown[];
  plans: unknown[];
  permissions: unknown[];
  cancels: unknown[];
  stops: number;
  texts: string[];
}

function recorder(overrides: Partial<ChatBridge> = {}): Recorder {
  const rec: Recorder = {
    approvals: [],
    answers: [],
    plans: [],
    permissions: [],
    cancels: [],
    stops: 0,
    texts: [],
    bridge: {} as ChatBridge,
  };
  const stopReport: EmergencyStopView = {
    engaged: true,
    stopped: ['t9'],
    cancellationUnconfirmed: [],
    unknown: [],
    reportedAt: NOW,
  };
  const actionOk: ChatActionResult = { ok: true };
  rec.bridge = {
    chatState: async () => emptyState(),
    sendText: async (text) => {
      rec.texts.push(text);
    },
    decideApproval: async (input) => {
      rec.approvals.push(input);
      return { ok: true, approvalId: 'a1', taskId: 't1', decision: 'approved' };
    },
    answerQuestion: async (input) => {
      rec.answers.push(input);
      return actionOk;
    },
    decidePlan: async (input) => {
      rec.plans.push(input);
      return actionOk;
    },
    decidePermission: async (input) => {
      rec.permissions.push(input);
      return actionOk;
    },
    cancelTask: async (input) => {
      rec.cancels.push(input);
      return { ok: true, detail: 'Cancellation requested.' };
    },
    emergencyStop: async () => {
      rec.stops += 1;
      return stopReport;
    },
    ...overrides,
  };
  return rec;
}

function emptyState(): ChatState {
  return { generatedAt: NOW, turns: [], tasks: [] };
}

function render(value: ChatState, overrides: Partial<ChatBridge> = {}) {
  document.body.innerHTML = '<main id="chat"></main>';
  const rec = recorder(overrides);
  renderChat(document, value, rec.bridge);
  return rec;
}

describe('chat renderer', () => {
  it('renders the pending approval with its exact scope', () => {
    render(approvalTask());
    const approval = document.querySelector('[data-testid="approval-a1"]');
    expect(approval).not.toBeNull();
    expect(approval?.textContent).toContain('deploy.service');
    expect(approval?.textContent).toContain('service:api');
    expect(approval?.textContent).toContain('elevated');
    expect(approval?.textContent).toContain('3');
    expect(approval?.textContent).toContain('u1');
  });

  it('sends the exact operation and plan version when approving', () => {
    const rec = render(approvalTask());
    const approve = document.querySelector('[data-testid="approve-a1"]') as HTMLButtonElement;
    approve.click();
    expect(rec.approvals).toHaveLength(1);
    expect(rec.approvals[0]).toMatchObject({
      approvalId: 'a1',
      taskId: 't1',
      planVersion: 3,
      decision: 'approved',
      operation: { capability: 'deploy.service', affectedResources: ['service:api'] },
    });
  });

  it('sends a rejection when the reject control is used', () => {
    const rec = render(approvalTask());
    (document.querySelector('[data-testid="reject-a1"]') as HTMLButtonElement).click();
    expect(rec.approvals[0]).toMatchObject({ decision: 'rejected' });
  });

  it('shows the progress bar and phase of a running task', () => {
    render({
      generatedAt: NOW,
      turns: [],
      tasks: [
        {
          taskId: 't2',
          title: 'Build',
          phase: 'running',
          status: 'running',
          progress: 55,
          questions: [],
          plans: [],
          permissions: [],
          updatedAt: NOW,
        },
      ],
    });
    const bar = document.querySelector('[data-testid="progress-t2"]') as HTMLProgressElement;
    expect(bar).not.toBeNull();
    expect(bar.value).toBe(55);
    expect(document.querySelector('[data-testid="phase-t2"]')?.textContent).toBe('running');
  });

  it('answers a pending question with the chosen option', () => {
    const rec = render({
      generatedAt: NOW,
      turns: [],
      tasks: [
        {
          taskId: 't3',
          title: 'Pick a region',
          phase: 'awaiting_input',
          status: 'running',
          questions: [
            {
              questionId: 'q1',
              question: 'Which region?',
              options: ['eu', 'us'],
              blocking: true,
            },
          ],
          plans: [],
          permissions: [],
          updatedAt: NOW,
        },
      ],
    });
    const question = document.querySelector('[data-testid="question-q1"]') as HTMLElement;
    const button = [...question.querySelectorAll('button')].find((b) => b.textContent === 'us');
    (button as HTMLButtonElement).click();
    expect(rec.answers[0]).toEqual({ taskId: 't3', questionId: 'q1', answer: 'us' });
  });

  it('decides a plan at its exact version', () => {
    const rec = render({
      generatedAt: NOW,
      turns: [],
      tasks: [
        {
          taskId: 't4',
          title: 'Roll out',
          phase: 'awaiting_plan',
          status: 'running',
          questions: [],
          plans: [
            { planId: 'p1', planVersion: 2, summary: 'Roll out', operations: ['deploy.service'] },
          ],
          permissions: [],
          updatedAt: NOW,
        },
      ],
    });
    const plan = document.querySelector('[data-testid="plan-p1-v2"]') as HTMLElement;
    const accept = [...plan.querySelectorAll('button')].find((b) => b.textContent === 'Accept plan');
    (accept as HTMLButtonElement).click();
    expect(rec.plans[0]).toEqual({ taskId: 't4', planId: 'p1', planVersion: 2, decision: 'accepted' });
  });

  it('decides a permission request', () => {
    const rec = render({
      generatedAt: NOW,
      turns: [],
      tasks: [
        {
          taskId: 't5',
          title: 'Needs filesystem',
          phase: 'awaiting_input',
          status: 'running',
          questions: [],
          plans: [],
          permissions: [
            {
              requestId: 'r1',
              capability: 'filesystem.write',
              scope: '/srv',
              requiresInteractiveAuth: true,
            },
          ],
          updatedAt: NOW,
        },
      ],
    });
    const permission = document.querySelector('[data-testid="permission-r1"]') as HTMLElement;
    const deny = [...permission.querySelectorAll('button')].find((b) => b.textContent === 'Deny');
    (deny as HTMLButtonElement).click();
    expect(rec.permissions[0]).toEqual({ taskId: 't5', requestId: 'r1', decision: 'denied' });
  });

  it('renders the terminal result only when verification is stated', () => {
    render({
      generatedAt: NOW,
      turns: [],
      tasks: [
        {
          taskId: 't6',
          title: 'Done',
          phase: 'completed_verified',
          status: 'succeeded',
          questions: [],
          plans: [],
          permissions: [],
          result: { outcome: 'succeeded', verification: 'confirmed', confirmed: true },
          updatedAt: NOW,
        },
      ],
    });
    const result = document.querySelector('[data-testid="result-t6"]') as HTMLElement;
    expect(result.getAttribute('data-outcome')).toBe('succeeded');
    expect(result.textContent).toContain('verified');
  });

  it('requests cancellation and shows the honest confirmation caveat', async () => {
    const rec = render({
      generatedAt: NOW,
      turns: [],
      tasks: [
        {
          taskId: 't7',
          title: 'Long task',
          phase: 'running',
          status: 'running',
          questions: [],
          plans: [],
          permissions: [],
          updatedAt: NOW,
        },
      ],
    });
    (document.querySelector('[data-testid="cancel-t7"]') as HTMLButtonElement).click();
    expect(rec.cancels[0]).toEqual({ taskId: 't7' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector('.card.task')?.textContent).toContain('Cancellation requested');
  });

  it('triggers an emergency stop from the dedicated control', () => {
    const rec = render(emptyState());
    (document.querySelector('[data-testid="emergency-stop"]') as HTMLButtonElement).click();
    expect(rec.stops).toBe(1);
  });

  it('sends a composed message and never opens a session for empty text', () => {
    const rec = render(emptyState());
    const input = document.querySelector('[data-testid="composer-input"]') as HTMLInputElement;
    const send = document.querySelector('[data-testid="composer-send"]') as HTMLButtonElement;
    input.value = '';
    send.click();
    expect(rec.texts).toHaveLength(0);
    input.value = 'hello';
    send.click();
    expect(rec.texts).toEqual(['hello']);
  });

  it('renders user turns in the conversation', () => {
    render({
      generatedAt: NOW,
      turns: [{ id: 'turn-1', role: 'user', text: 'ship it', at: NOW, state: 'complete' }],
      tasks: [],
    });
    expect(document.querySelector('.turn-user .text')?.textContent).toBe('ship it');
  });
});
