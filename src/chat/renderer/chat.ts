import type { ApprovalDecisionOutcome, ChatActionResult, ChatState, ChatTaskView } from '../state.js';
import type { EmergencyStopView } from '../state.js';

export interface ChatBridge {
  chatState(): Promise<ChatState>;
  sendText(text: string): Promise<void>;
  decideApproval(input: unknown): Promise<ApprovalDecisionOutcome>;
  answerQuestion(input: unknown): Promise<ChatActionResult>;
  decidePlan(input: unknown): Promise<ChatActionResult>;
  decidePermission(input: unknown): Promise<ChatActionResult>;
  cancelTask(input: unknown): Promise<ChatActionResult>;
  muteCapture(input: unknown): Promise<ChatActionResult>;
  interruptSpeech(): Promise<ChatActionResult>;
  stopPlayback(): Promise<ChatActionResult>;
  emergencyStop(): Promise<EmergencyStopView>;
}

type El = HTMLElement;

function h<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className !== undefined) node.className = className;
  return node;
}

function note(doc: Document, text: string, className = 'reason'): El {
  const node = h(doc, 'p', className);
  node.textContent = text;
  return node;
}

function conversationSection(doc: Document, state: ChatState): El {
  const wrap = h(doc, 'section', 'card conversations');
  const heading = h(doc, 'h2');
  heading.textContent = 'Conversation';
  wrap.append(heading);
  if (state.turns.length === 0) {
    wrap.append(note(doc, 'No messages yet. Type below to start.', 'muted'));
    return wrap;
  }
  const list = h(doc, 'ul', 'turns');
  for (const turn of state.turns) {
    const item = h(doc, 'li', `turn turn-${turn.role}`);
    item.setAttribute('data-state', turn.state);
    const who = h(doc, 'span', 'who');
    who.textContent = turn.role;
    const text = h(doc, 'span', 'text');
    text.textContent = turn.text;
    item.append(who, text);
    if (turn.error !== undefined) item.append(note(doc, turn.error));
    if (turn.submittedTaskId !== undefined) {
      const marker = note(
        doc,
        `Submitted as tracked work${turn.routeCapability !== undefined ? ` (${turn.routeCapability})` : ''}. Approval required.`,
        'muted',
      );
      marker.setAttribute('data-testid', `submitted-${turn.submittedTaskId}`);
      item.append(marker);
    }
    list.append(item);
  }
  wrap.append(list);
  return wrap;
}

function approvalSection(doc: Document, task: ChatTaskView, bridge: ChatBridge, refresh: () => void): El {
  const approval = task.approval as NonNullable<ChatTaskView['approval']>;
  const wrap = h(doc, 'div', 'approval');
  wrap.setAttribute('data-testid', `approval-${approval.approvalId}`);
  const title = h(doc, 'h3');
  title.textContent = 'Approval required';
  wrap.append(title);

  const rows: readonly [string, string][] = [
    ['Task', `${task.title} (${task.taskId})`],
    ['Requested by', approval.requestedBy],
    ['Operation', approval.scope.capability],
    ['Scope', approval.scope.affectedResources.join(', ') || 'no resources listed'],
    ['Risk tier', approval.scope.riskTier],
    ['Plan version', String(approval.scope.planVersion)],
    [
      'Expires',
      approval.scope.expiresAt ?? 'no expiry reported',
    ],
  ];
  for (const [label, value] of rows) {
    const line = h(doc, 'div', 'row');
    const name = h(doc, 'span', 'row-label');
    name.textContent = label;
    const val = h(doc, 'span', 'row-value');
    val.textContent = value;
    line.append(name, val);
    wrap.append(line);
  }
  wrap.append(
    note(doc, 'Approving authorizes exactly this one operation at this plan version.'),
  );

  const actions = h(doc, 'div', 'actions');
  const decide = (decision: 'approved' | 'rejected'): void => {
    void bridge
      .decideApproval({
        approvalId: approval.approvalId,
        taskId: approval.taskId,
        planVersion: approval.scope.planVersion,
        operation: {
          capability: approval.scope.capability,
          parameters: {},
          privilege: 'user',
          riskTier: approval.scope.riskTier,
          affectedResources: approval.scope.affectedResources,
        },
        decision,
      })
      .then((outcome) => {
        if (!outcome.ok) {
          wrap.append(note(doc, outcome.reason));
          return;
        }
        refresh();
      });
  };
  const approve = h(doc, 'button');
  approve.setAttribute('data-testid', `approve-${approval.approvalId}`);
  approve.textContent = 'Approve';
  approve.addEventListener('click', () => decide('approved'));
  const reject = h(doc, 'button');
  reject.setAttribute('data-testid', `reject-${approval.approvalId}`);
  reject.textContent = 'Reject';
  reject.addEventListener('click', () => decide('rejected'));
  actions.append(approve, reject);
  wrap.append(actions);
  return wrap;
}

function questionsBlock(doc: Document, task: ChatTaskView, bridge: ChatBridge, refresh: () => void): El {
  const wrap = h(doc, 'div', 'questions');
  for (const question of task.questions) {
    const item = h(doc, 'div', 'question');
    item.setAttribute('data-testid', `question-${question.questionId}`);
    const text = h(doc, 'p', 'question-text');
    text.textContent = question.question;
    item.append(text);
    if (!question.blocking) item.append(note(doc, 'Informational; work can continue.', 'muted'));
    const options = question.options.length > 0 ? question.options : ['Yes', 'No'];
    for (const option of options) {
      const btn = h(doc, 'button');
      btn.textContent = option;
      btn.addEventListener('click', () => {
        void bridge
          .answerQuestion({ taskId: task.taskId, questionId: question.questionId, answer: option })
          .then((result) => {
            if (!result.ok) item.append(note(doc, result.reason));
            else refresh();
          });
      });
      item.append(btn);
    }
    wrap.append(item);
  }
  return wrap;
}

function plansBlock(doc: Document, task: ChatTaskView, bridge: ChatBridge, refresh: () => void): El {
  const wrap = h(doc, 'div', 'plans');
  for (const plan of task.plans) {
    const item = h(doc, 'div', 'plan');
    item.setAttribute('data-testid', `plan-${plan.planId}-v${plan.planVersion}`);
    const text = h(doc, 'p', 'plan-summary');
    text.textContent = `${plan.summary} (v${plan.planVersion})`;
    item.append(text);
    if (plan.operations.length > 0) {
      const ops = h(doc, 'ul', 'operations');
      for (const op of plan.operations) {
        const li = h(doc, 'li');
        li.textContent = op;
        ops.append(li);
      }
      item.append(ops);
    }
    for (const decision of ['accepted', 'rejected'] as const) {
      const btn = h(doc, 'button');
      btn.textContent = decision === 'accepted' ? 'Accept plan' : 'Reject plan';
      btn.addEventListener('click', () => {
        void bridge
          .decidePlan({
            taskId: task.taskId,
            planId: plan.planId,
            planVersion: plan.planVersion,
            decision,
          })
          .then((result) => {
            if (!result.ok) item.append(note(doc, result.reason));
            else refresh();
          });
      });
      item.append(btn);
    }
    wrap.append(item);
  }
  return wrap;
}

function permissionsBlock(doc: Document, task: ChatTaskView, bridge: ChatBridge, refresh: () => void): El {
  const wrap = h(doc, 'div', 'permissions');
  for (const permission of task.permissions) {
    const item = h(doc, 'div', 'permission');
    item.setAttribute('data-testid', `permission-${permission.requestId}`);
    const text = h(doc, 'p', 'permission-text');
    text.textContent = permission.summary ?? `${permission.capability} for ${permission.scope}`;
    item.append(text);
    const detail = h(doc, 'p', 'muted');
    detail.textContent =
      `Scope: ${permission.scope}. ` +
      (permission.requiresInteractiveAuth
        ? 'Granting only tells AI-Engineer to request authorization; it does not authorize.'
        : 'Declining is always safe.');
    item.append(detail);
    for (const decision of ['granted', 'denied'] as const) {
      const btn = h(doc, 'button');
      btn.textContent = decision === 'granted' ? 'Grant' : 'Deny';
      btn.addEventListener('click', () => {
        void bridge
          .decidePermission({
            taskId: task.taskId,
            requestId: permission.requestId,
            decision,
          })
          .then((result) => {
            if (!result.ok) item.append(note(doc, result.reason));
            else refresh();
          });
      });
      item.append(btn);
    }
    wrap.append(item);
  }
  return wrap;
}

function resultBlock(doc: Document, task: ChatTaskView): El {
  const result = task.result as NonNullable<ChatTaskView['result']>;
  const item = h(doc, 'p', 'result');
  item.setAttribute('data-testid', `result-${task.taskId}`);
  item.setAttribute('data-outcome', result.outcome);
  item.textContent = result.confirmed
    ? `Succeeded and verified (${result.outcome}).`
    : `Outcome: ${result.outcome} · verification: ${result.verification}.`;
  return item;
}

function taskSection(doc: Document, task: ChatTaskView, bridge: ChatBridge, refresh: () => void): El {
  const wrap = h(doc, 'section', 'card task');
  wrap.setAttribute('data-testid', `task-${task.taskId}`);
  const heading = h(doc, 'h2');
  heading.textContent = task.title;
  wrap.append(heading);

  const phase = h(doc, 'div', 'row');
  const label = h(doc, 'span', 'row-label');
  label.textContent = 'Phase';
  const value = h(doc, 'span', 'row-value');
  value.setAttribute('data-testid', `phase-${task.taskId}`);
  value.textContent = task.phase;
  phase.append(label, value);
  wrap.append(phase);

  if (task.progress !== undefined) {
    const bar = h(doc, 'progress');
    bar.max = 100;
    bar.value = task.progress;
    bar.setAttribute('data-testid', `progress-${task.taskId}`);
    wrap.append(bar);
  }

  if (task.approval !== undefined) wrap.append(approvalSection(doc, task, bridge, refresh));
  wrap.append(questionsBlock(doc, task, bridge, refresh));
  wrap.append(plansBlock(doc, task, bridge, refresh));
  wrap.append(permissionsBlock(doc, task, bridge, refresh));
  if (task.result !== undefined) wrap.append(resultBlock(doc, task));

  if (task.phase !== 'completed_verified' && task.phase !== 'failed' && task.phase !== 'cancelled_confirmed') {
    wrap.append(cancelBlock(doc, task, bridge));
  }
  return wrap;
}

function cancelBlock(doc: Document, task: ChatTaskView, bridge: ChatBridge): El {
  const wrap = h(doc, 'div', 'cancel-controls');
  const request = h(doc, 'button');
  request.setAttribute('data-testid', `cancel-${task.taskId}`);
  request.textContent = 'Request cancellation';
  request.addEventListener('click', () => {
    wrap.querySelectorAll('.reason').forEach((node) => node.remove());
    void bridge.cancelTask({ taskId: task.taskId }).then((result) => {
      wrap.append(note(doc, result.ok ? (result.detail ?? 'Cancellation requested.') : result.reason, result.ok ? 'outcome' : 'reason'));
    });
  });
  wrap.append(request);

  const interrupt = h(doc, 'button');
  interrupt.setAttribute('data-testid', `interrupt-${task.taskId}`);
  interrupt.textContent = 'Interrupt speech';
  interrupt.addEventListener('click', () => {
    void bridge.interruptSpeech().then((result) => {
      wrap.append(note(doc, result.ok ? (result.detail ?? 'Speech interrupted.') : result.reason, 'muted'));
    });
  });
  wrap.append(interrupt);

  const stop = h(doc, 'button');
  stop.setAttribute('data-testid', `stop-playback-${task.taskId}`);
  stop.textContent = 'Stop playback';
  stop.addEventListener('click', () => {
    void bridge.stopPlayback().then((result) => {
      wrap.append(note(doc, result.ok ? (result.detail ?? 'Playback stopped.') : result.reason, 'muted'));
    });
  });
  wrap.append(stop);
  return wrap;
}

function emergencySection(doc: Document, state: ChatState, bridge: ChatBridge, refresh: () => void): El {
  const wrap = h(doc, 'section', 'card emergency');
  const heading = h(doc, 'h2');
  heading.textContent = 'Emergency stop';
  wrap.append(heading);

  const controls = h(doc, 'div', 'emergency-controls');

  const stop = h(doc, 'button');
  stop.setAttribute('data-testid', 'emergency-stop');
  stop.textContent = 'Emergency stop';
  stop.addEventListener('click', () => {
    void bridge.emergencyStop().then(() => refresh());
  });
  controls.append(stop);

  const mute = h(doc, 'button');
  mute.setAttribute('data-testid', 'mute-capture');
  mute.textContent = state.mute?.muted === true ? 'Unmute capture' : 'Mute capture';
  mute.setAttribute('data-muted', String(state.mute?.muted === true));
  mute.addEventListener('click', () => {
    void bridge.muteCapture({ muted: state.mute?.muted !== true }).then(() => refresh());
  });
  controls.append(mute);

  const interrupt = h(doc, 'button');
  interrupt.setAttribute('data-testid', 'interrupt-speech');
  interrupt.textContent = 'Interrupt speech';
  interrupt.addEventListener('click', () => {
    void bridge.interruptSpeech().then(() => refresh());
  });
  controls.append(interrupt);

  wrap.append(controls);

  const report = state.emergencyStop;
  if (report !== undefined) {
    wrap.append(note(doc, `Engaged: ${report.engaged ? 'yes' : 'no'}.`, 'outcome'));
    if (report.stopped.length > 0) {
      wrap.append(note(doc, `Stopped (confirmed): ${report.stopped.join(', ')}`, 'outcome'));
    } else {
      wrap.append(note(doc, 'No stops were confirmed.', 'muted'));
    }
    if (report.cancellationUnconfirmed.length > 0) {
      wrap.append(
        note(doc, `Cancellation requested, not confirmed: ${report.cancellationUnconfirmed.join(', ')}`, 'muted'),
      );
    }
    if (report.unknown.length > 0) {
      wrap.append(note(doc, `Unknown outcome: ${report.unknown.join(', ')}`, 'muted'));
    }
  }
  return wrap;
}

function composer(doc: Document, bridge: ChatBridge, refresh: () => void): El {
  const wrap = h(doc, 'form', 'composer');
  const input = h(doc, 'input', 'composer-input');
  input.type = 'text';
  input.placeholder = 'Type a message';
  input.setAttribute('data-testid', 'composer-input');
  const send = h(doc, 'button', 'composer-send');
  send.type = 'submit';
  send.textContent = 'Send';
  send.setAttribute('data-testid', 'composer-send');
  wrap.append(input, send);
  wrap.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value;
    if (text.trim() === '') return;
    input.value = '';
    void bridge.sendText(text).then(() => refresh());
  });
  return wrap;
}

export function renderChat(doc: Document, state: ChatState, bridge: ChatBridge): void {
  const root = doc.getElementById('chat');
  if (root === null) return;
  const refresh = (): void => {
    void bridge.chatState().then((next) => renderChat(doc, next, bridge));
  };
  root.replaceChildren(conversationSection(doc, state));
  for (const task of state.tasks) {
    root.append(taskSection(doc, task, bridge, refresh));
  }
  root.append(emergencySection(doc, state, bridge, refresh));
  root.append(composer(doc, bridge, refresh));
}

export function bootstrapChat(doc: Document, bridge: ChatBridge): void {
  const root = doc.getElementById('chat');
  if (root !== null) {
    root.replaceChildren(note(doc, 'Loading chat…', 'muted'));
  }
  void bridge.chatState().then((state) => renderChat(doc, state, bridge));
}

const injected = (globalThis as { aria?: ChatBridge }).aria;

if (typeof document !== 'undefined' && injected !== undefined) {
  bootstrapChat(document, injected);
}
