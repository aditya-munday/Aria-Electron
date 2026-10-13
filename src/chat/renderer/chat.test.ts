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
  mutes: unknown[];
  interrupts: number;
  playbackStops: number;
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
    mutes: [],
    interrupts: 0,
    playbackStops: 0,
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
    muteCapture: async (input) => {
      rec.mutes.push(input);
      return { ok: true, detail: 'Capture muted.' };
    },
    interruptSpeech: async () => {
      rec.interrupts += 1;
      return { ok: true, detail: 'Speech interrupted.' };
    },
    stopPlayback: async () => {
      rec.playbackStops += 1;
      return { ok: true, detail: 'Playback stopped.' };
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
  it('marks a user turn that was submitted as tracked work', () => {
    render({
      generatedAt: NOW,
      turns: [
        {
          id: 'turn-1',
          role: 'user',
          text: 'deploy the api',
          at: NOW,
          state: 'complete',
          submittedTaskId: 't9',
          routeCapability: 'deploy.service',
        },
        { id: 'turn-2', role: 'assistant', text: 'Working on it.', at: NOW, state: 'complete' },
      ],
      tasks: [],
    });
    const marker = document.querySelector('[data-testid="submitted-t9"]');
    expect(marker).not.toBeNull();
    expect(marker?.textContent).toContain('deploy.service');
    expect(marker?.textContent).toContain('Approval required');
  });

  it('renders a plain conversation turn with no submission marker', () => {
    render({
      generatedAt: NOW,
      turns: [
        { id: 'turn-1', role: 'user', text: 'hello', at: NOW, state: 'complete' },
        { id: 'turn-2', role: 'assistant', text: 'Hi there.', at: NOW, state: 'complete' },
      ],
      tasks: [],
    });
    expect(document.querySelector('[data-testid^="submitted-"]')).toBeNull();
    expect(document.querySelectorAll('.turns .turn')).toHaveLength(2);
  });

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

  it('mutes capture and reflects the muted state on the control', async () => {
    const rec = render({
      generatedAt: NOW,
      turns: [],
      tasks: [],
      mute: { muted: true, mode: 'idle' },
    });
    const button = document.querySelector('[data-testid="mute-capture"]') as HTMLButtonElement;
    expect(button.textContent).toBe('Unmute capture');
    expect(button.getAttribute('data-muted')).toBe('true');
    button.click();
    expect(rec.mutes[0]).toEqual({ muted: false });
  });

  it('interrupts speech and stops playback from the emergency controls', async () => {
    const rec = render(emptyState());
    (document.querySelector('[data-testid="interrupt-speech"]') as HTMLButtonElement).click();
    expect(rec.interrupts).toBe(1);
    const task = render({
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
    (document.querySelector('[data-testid="stop-playback-t7"]') as HTMLButtonElement).click();
    expect(task.playbackStops).toBe(1);
    (document.querySelector('[data-testid="interrupt-t7"]') as HTMLButtonElement).click();
    expect(task.interrupts).toBe(1);
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
    expect(document.querySelector('.turn-user .rich')?.textContent).toContain('ship it');
  });

  it('renders the empty state with quick-start prompts', () => {
    const rec = render(emptyState());
    expect(document.querySelector('.hero-title')?.textContent).toContain('How can I help');
    const chip = [...document.querySelectorAll('.chip')].find(
      (c) => c.textContent === 'Summarize my tasks',
    ) as HTMLButtonElement;
    expect(chip).toBeTruthy();
    chip.click();
    expect(rec.texts).toEqual(['Summarize my tasks']);
  });

  it('renders assistant replies with rich formatting (code, lists, bold)', () => {
    render({
      generatedAt: NOW,
      turns: [
        {
          id: 'turn-1',
          role: 'assistant',
          text: 'Try:\n- **one**\n- two\n\n```ts\nconst x = 1;\n```',
          at: NOW,
          state: 'complete',
        },
      ],
      tasks: [],
    });
    expect(document.querySelector('.rich-list li strong')?.textContent).toBe('one');
    expect(document.querySelector('.code-block code')?.textContent).toContain('const x = 1;');
  });

  it('shows a thinking indicator for a pending assistant turn', () => {
    render({
      generatedAt: NOW,
      turns: [{ id: 'turn-1', role: 'assistant', text: '', at: NOW, state: 'pending' }],
      tasks: [],
    });
    expect(document.querySelector('.typing')).not.toBeNull();
  });

  it('offers copy and regenerate actions on assistant turns', () => {
    const rec = render({
      generatedAt: NOW,
      turns: [
        { id: 'turn-1', role: 'user', text: 'hi', at: NOW, state: 'complete' },
        { id: 'turn-2', role: 'assistant', text: 'hello', at: NOW, state: 'complete' },
      ],
      tasks: [],
    });
    const actions = [...document.querySelectorAll('.turn-assistant .msg-action')];
    expect(actions.length).toBeGreaterThanOrEqual(3);
    const retry = actions.find((a) => a.getAttribute('aria-label') === 'Regenerate reply');
    (retry as HTMLButtonElement).click();
    expect(rec.texts).toEqual(['hi']);
  });

  it('renders a textarea composer and sends on submit', () => {
    const rec = render(emptyState());
    const input = document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    expect(input.tagName).toBe('TEXTAREA');
    input.value = 'ping';
    (document.querySelector('[data-testid="composer-send"]') as HTMLButtonElement).click();
    expect(rec.texts).toEqual(['ping']);
  });

  it('paints the user turn and a pending reply optimistically on submit', () => {
    render(emptyState());
    const input = document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    input.value = 'optimistic hello';
    (document.querySelector('[data-testid="composer-send"]') as HTMLButtonElement).click();
    expect(document.querySelector('.turn-user .rich')?.textContent).toContain('optimistic hello');
    expect(document.querySelector('.turn[data-state="pending"]')).not.toBeNull();
  });

  it('offers a stop control only while a reply is pending', () => {
    render(emptyState());
    expect(document.querySelector('[data-testid="composer-stop"]')).toBeNull();
    const rec = render({
      generatedAt: NOW,
      turns: [{ id: 'turn-1', role: 'assistant', text: '', at: NOW, state: 'pending' }],
      tasks: [],
    });
    const stop = document.querySelector('[data-testid="composer-stop"]') as HTMLButtonElement;
    expect(stop).not.toBeNull();
    stop.click();
    expect(rec.interrupts).toBe(1);
  });

  it('clears the composer on Escape', () => {
    render(emptyState());
    const input = document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement;
    input.value = 'discard me';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(input.value).toBe('');
  });

  it('keeps the caret in the composer across a repaint', () => {
    document.body.innerHTML = '<main id="chat"></main>';
    const rec = recorder();
    const root = document.getElementById('chat') as HTMLElement;
    renderChat(document, emptyState(), rec.bridge);
    const input = document.querySelector('[data-testid="composer-input"]') as HTMLInputElement;
    input.focus();
    input.value = 'draft text';
    input.setSelectionRange(4, 4);

    renderChat(document, emptyState(), rec.bridge);

    const repainted = document.querySelector('[data-testid="composer-input"]') as HTMLInputElement;
    expect(document.activeElement).toBe(repainted);
    expect(root.scrollTop).toBe(0);
  });
});
