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

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Icons are 24x24 line glyphs; one path each keeps the bundle tiny. */
const ICON: Readonly<Record<string, string>> = {
  send: 'M4 12 20 4l-4 16-4-6-8-2Z',
  copy: 'M9 9h10v12H9zM5 3h10v3H8v9H5z',
  retry: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6',
  down: 'M7 10l5 5 5-5',
  stop: 'M7 7h10v10H7z',
  spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z',
  thumbUp: 'M7 10v10H4V10h3Zm3 0 4-7a2 2 0 0 1 2 2v4h4a2 2 0 0 1 2 2l-1.3 6a2 2 0 0 1-2 1.6H10V10Z',
  thumbDown: 'M17 14V4h3v10h-3Zm-3 0-4 7a2 2 0 0 1-2-2v-4H4a2 2 0 0 1-2-2l1.3-6A2 2 0 0 1 5.3 4H14v10Z',
};

function h<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className !== undefined) node.className = className;
  return node;
}

function icon(doc: Document, name: string): SVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICON[name] ?? ICON['spark'] ?? '');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.9');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function note(doc: Document, text: string, className = 'reason'): El {
  const node = h(doc, 'p', className);
  node.textContent = text;
  if (className === 'outcome' || className === 'reason') {
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
  }
  return node;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Render a message body as safe DOM: fenced code blocks, bullet/numbered lists,
 * inline code and bold. No `innerHTML`, so a hostile reply can never inject a
 * node — every segment lands as a text node.
 */
function richText(doc: Document, text: string): El {
  const wrap = h(doc, 'div', 'rich');
  text.split(/```/).forEach((segment, index) => {
    if (index % 2 === 1) {
      const lines = segment.replace(/^\n/, '').split('\n');
      const firstLine = lines[0] ?? '';
      const rest = lines.slice(1);
      const code = h(doc, 'pre', 'code-block');
      const body = h(doc, 'code');
      body.textContent = rest.length > 0 ? rest.join('\n').replace(/\n$/, '') : firstLine;
      if (rest.length > 0 && firstLine.trim() !== '') code.setAttribute('data-lang', firstLine.trim());
      code.append(body);
      wrap.append(code);
      return;
    }
    appendBlocks(doc, wrap, segment);
  });
  return wrap;
}

function appendBlocks(doc: Document, wrap: El, segment: string): void {
  let list: HTMLUListElement | HTMLOListElement | undefined;
  const flush = (): void => {
    if (list !== undefined) {
      wrap.append(list);
      list = undefined;
    }
  };
  for (const raw of segment.split('\n')) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (bullet !== null) {
      if (!(list instanceof HTMLUListElement)) {
        flush();
        list = h(doc, 'ul', 'rich-list');
      }
      list.append(inlineItem(doc, bullet[1] ?? ''));
      continue;
    }
    if (numbered !== null) {
      if (!(list instanceof HTMLOListElement)) {
        flush();
        list = h(doc, 'ol', 'rich-list');
      }
      list.append(inlineItem(doc, numbered[1] ?? ''));
      continue;
    }
    flush();
    if (line.trim() === '') continue;
    const p = h(doc, 'p', 'rich-p');
    appendInline(doc, p, line);
    wrap.append(p);
  }
  flush();
}

function inlineItem(doc: Document, text: string): HTMLElement {
  const node = h(doc, 'li');
  appendInline(doc, node, text);
  return node;
}

/** Inline spans: `code` and **bold**. Everything else is literal text. */
function appendInline(doc: Document, parent: El, text: string): void {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) parent.append(doc.createTextNode(text.slice(last, match.index)));
    const token = match[0];
    if (token.startsWith('`')) {
      const code = h(doc, 'code', 'inline-code');
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else {
      const strong = h(doc, 'strong');
      strong.textContent = token.slice(2, -2);
      parent.append(strong);
    }
    last = match.index + token.length;
  }
  if (last < text.length) parent.append(doc.createTextNode(text.slice(last)));
}

function avatar(doc: Document, role: string): El {
  const node = h(doc, 'div', `avatar avatar-${role}`);
  node.setAttribute('aria-hidden', 'true');
  if (role === 'assistant') node.append(icon(doc, 'spark'));
  else node.textContent = role === 'user' ? 'Y' : 'S';
  return node;
}

interface MessageAction {
  readonly label: string;
  readonly icon: string;
  readonly onClick: () => void;
}

function actionButton(doc: Document, action: MessageAction): El {
  const btn = h(doc, 'button', 'msg-action');
  btn.type = 'button';
  btn.setAttribute('aria-label', action.label);
  btn.title = action.label;
  btn.append(icon(doc, action.icon));
  btn.addEventListener('click', (event) => {
    event.preventDefault();
    action.onClick();
  });
  return btn;
}

function messageRow(
  doc: Document,
  turn: ChatState['turns'][number],
  actions: readonly MessageAction[],
): El {
  const item = h(doc, 'li', `turn turn-${turn.role}`);
  item.setAttribute('data-state', turn.state);
  item.setAttribute('data-turn', turn.id);

  const body = h(doc, 'div', 'bubble');
  if (turn.state === 'pending' && turn.text.trim() === '') body.append(typingDots(doc));
  else body.append(richText(doc, turn.text));

  const meta = h(doc, 'div', 'meta');
  const who = h(doc, 'span', 'who');
  who.textContent = turn.role === 'user' ? 'You' : 'Aria';
  const time = h(doc, 'time', 'time');
  time.textContent = formatTime(turn.at);
  meta.append(who, time);

  if (turn.error !== undefined) {
    const err = h(doc, 'p', 'error');
    err.textContent = turn.error;
    err.setAttribute('role', 'status');
    body.append(err);
  }
  if (turn.submittedTaskId !== undefined) {
    const marker = h(doc, 'p', 'submitted');
    marker.setAttribute('data-testid', `submitted-${turn.submittedTaskId}`);
    marker.setAttribute('role', 'status');
    marker.setAttribute('aria-live', 'polite');
    marker.textContent = `Submitted as tracked work${turn.routeCapability !== undefined ? ` (${turn.routeCapability})` : ''}. Approval required.`;
    body.append(marker);
  }

  const column = h(doc, 'div', 'msg-col');
  column.append(meta, body);
  if (actions.length > 0) {
    const bar = h(doc, 'div', 'msg-actions');
    for (const action of actions) bar.append(actionButton(doc, action));
    column.append(bar);
  }
  item.append(avatar(doc, turn.role), column);
  return item;
}

function typingDots(doc: Document): El {
  const wrap = h(doc, 'div', 'typing');
  wrap.setAttribute('aria-label', 'Aria is thinking');
  wrap.setAttribute('role', 'status');
  for (let i = 0; i < 3; i += 1) wrap.append(h(doc, 'span', 'dot'));
  return wrap;
}

function conversationSection(
  doc: Document,
  state: ChatState,
  bridge: ChatBridge,
  refresh: () => void,
): El {
  const wrap = h(doc, 'section', 'card conversations');
  const heading = h(doc, 'h2');
  heading.textContent = 'Conversation';
  wrap.append(heading);

  if (state.turns.length === 0) {
    wrap.append(emptyHero(doc, bridge, refresh));
    return wrap;
  }

  const list = h(doc, 'ul', 'turns');
  list.setAttribute('role', 'log');
  list.setAttribute('aria-live', 'polite');
  state.turns.forEach((turn, index) => {
    const actions: MessageAction[] = [];
    if (turn.role !== 'system') {
      actions.push({
        label: 'Copy message',
        icon: 'copy',
        onClick: () => void copyText(turn.text),
      });
    }
    if (turn.role === 'assistant') {
      const priorUser = [...state.turns.slice(0, index)].reverse().find((t) => t.role === 'user');
      if (priorUser !== undefined) {
        actions.push({
          label: 'Regenerate reply',
          icon: 'retry',
          onClick: () => {
            void bridge.sendText(priorUser.text).then(() => refresh());
          },
        });
      }
      actions.push(feedbackAction('thumbUp', 'Helpful'));
      actions.push(feedbackAction('thumbDown', 'Not helpful'));
    }
    list.append(messageRow(doc, turn, actions));
  });
  wrap.append(list);
  return wrap;
}

/** Feedback is a local acknowledgement only; it is not sent anywhere. */
function feedbackAction(iconName: string, label: string): MessageAction {
  return { label, icon: iconName, onClick: () => undefined };
}

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(value);
  } catch {
    // Clipboard access can be denied; the action is best-effort.
  }
}

const QUICK_STARTS = [
  'What can you do?',
  'Summarize my tasks',
  'Draft a reply',
  'Explain my last result',
] as const;

function emptyHero(doc: Document, bridge: ChatBridge, refresh: () => void): El {
  const hero = h(doc, 'div', 'hero');
  const mark = h(doc, 'div', 'hero-mark');
  mark.append(icon(doc, 'spark'));
  const title = h(doc, 'h3', 'hero-title');
  title.textContent = 'How can I help today?';
  const sub = h(doc, 'p', 'hero-sub');
  sub.textContent =
    'Ask in plain language. Aria routes it, tracks it and tells you the truth about what happened.';
  hero.append(mark, title, sub);

  const chips = h(doc, 'div', 'chips');
  for (const prompt of QUICK_STARTS) {
    const chip = h(doc, 'button', 'chip');
    chip.type = 'button';
    chip.textContent = prompt;
    chip.addEventListener('click', () => {
      void bridge.sendText(prompt).then(() => refresh());
    });
    chips.append(chip);
  }
  hero.append(chips);
  return hero;
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
    ['Expires', approval.scope.expiresAt ?? 'no expiry reported'],
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
  wrap.append(note(doc, 'Approving authorizes exactly this one operation at this plan version.'));

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
  const approve = h(doc, 'button', 'btn btn-approve');
  approve.setAttribute('data-testid', `approve-${approval.approvalId}`);
  approve.textContent = 'Approve';
  approve.setAttribute('aria-label', `Approve ${approval.scope.capability} for ${task.title}`);
  approve.addEventListener('click', () => decide('approved'));
  const reject = h(doc, 'button', 'btn btn-reject');
  reject.setAttribute('data-testid', `reject-${approval.approvalId}`);
  reject.textContent = 'Reject';
  reject.setAttribute('aria-label', `Reject ${approval.scope.capability} for ${task.title}`);
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
    const optionsWrap = h(doc, 'div', 'options');
    for (const option of options) {
      const btn = h(doc, 'button', 'btn btn-option');
      btn.textContent = option;
      btn.addEventListener('click', () => {
        void bridge
          .answerQuestion({ taskId: task.taskId, questionId: question.questionId, answer: option })
          .then((result) => {
            if (!result.ok) item.append(note(doc, result.reason));
            else refresh();
          });
      });
      optionsWrap.append(btn);
    }
    item.append(optionsWrap);
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
    const actions = h(doc, 'div', 'actions');
    for (const decision of ['accepted', 'rejected'] as const) {
      const btn = h(doc, 'button', `btn ${decision === 'accepted' ? 'btn-approve' : 'btn-reject'}`);
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
      actions.append(btn);
    }
    item.append(actions);
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
    if (permission.requiresInteractiveAuth) {
      item.append(note(doc, 'This permission needs your interactive authorization.', 'muted'));
    }
    const actions = h(doc, 'div', 'actions');
    for (const decision of ['granted', 'denied'] as const) {
      const btn = h(doc, 'button', `btn ${decision === 'granted' ? 'btn-approve' : 'btn-reject'}`);
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
      actions.append(btn);
    }
    item.append(actions);
    wrap.append(item);
  }
  return wrap;
}

function resultBlock(doc: Document, task: ChatTaskView): El {
  const result = task.result as NonNullable<ChatTaskView['result']>;
  const item = h(doc, 'div', 'result');
  item.setAttribute('data-testid', `result-${task.taskId}`);
  item.setAttribute('data-outcome', result.outcome);
  const verdict = h(doc, 'span', 'verdict');
  verdict.textContent = result.confirmed ? 'Verified' : 'Not verified';
  verdict.setAttribute('data-confirmed', String(result.confirmed));
  const body = h(doc, 'p', 'result-text');
  body.textContent = result.confirmed
    ? `Succeeded and verified (${result.outcome}).`
    : `Outcome: ${result.outcome} · verification: ${result.verification}.`;
  item.append(verdict, body);
  return item;
}

const PHASE_TONE: Readonly<Record<string, string>> = {
  completed_verified: 'ok',
  failed: 'bad',
  cancelled_confirmed: 'neutral',
  awaiting_approval: 'warn',
  awaiting_input: 'warn',
  awaiting_plan: 'warn',
  running: 'accent',
};

function taskSection(doc: Document, task: ChatTaskView, bridge: ChatBridge, refresh: () => void): El {
  const wrap = h(doc, 'section', 'card task');
  wrap.setAttribute('data-testid', `task-${task.taskId}`);
  const head = h(doc, 'div', 'task-head');
  const heading = h(doc, 'h2');
  heading.textContent = task.title;
  const tone = PHASE_TONE[task.phase] ?? 'neutral';
  const pill = h(doc, 'span', `pill pill-${tone}`);
  pill.setAttribute('data-testid', `phase-${task.taskId}`);
  pill.textContent = task.phase;
  head.append(heading, pill);
  wrap.append(head);

  if (task.progress !== undefined) {
    const track = h(doc, 'div', 'progress-track');
    const bar = h(doc, 'progress');
    bar.max = 100;
    bar.value = task.progress;
    bar.setAttribute('data-testid', `progress-${task.taskId}`);
    track.append(bar);
    wrap.append(track);
  }

  if (task.approval !== undefined) wrap.append(approvalSection(doc, task, bridge, refresh));
  wrap.append(questionsBlock(doc, task, bridge, refresh));
  wrap.append(plansBlock(doc, task, bridge, refresh));
  wrap.append(permissionsBlock(doc, task, bridge, refresh));
  if (task.result !== undefined) wrap.append(resultBlock(doc, task));

  if (
    task.phase !== 'completed_verified' &&
    task.phase !== 'failed' &&
    task.phase !== 'cancelled_confirmed'
  ) {
    wrap.append(cancelBlock(doc, task, bridge));
  }
  return wrap;
}

function cancelBlock(doc: Document, task: ChatTaskView, bridge: ChatBridge): El {
  const wrap = h(doc, 'div', 'cancel-controls');
  const request = h(doc, 'button', 'btn');
  request.setAttribute('data-testid', `cancel-${task.taskId}`);
  request.textContent = 'Request cancellation';
  request.setAttribute('aria-label', `Request cancellation of ${task.title}`);
  request.addEventListener('click', () => {
    wrap.querySelectorAll('.reason, .outcome').forEach((node) => node.remove());
    void bridge.cancelTask({ taskId: task.taskId }).then((result) => {
      wrap.append(
        note(
          doc,
          result.ok ? (result.detail ?? 'Cancellation requested.') : result.reason,
          result.ok ? 'outcome' : 'reason',
        ),
      );
    });
  });
  wrap.append(request);

  const interrupt = h(doc, 'button', 'btn');
  interrupt.setAttribute('data-testid', `interrupt-${task.taskId}`);
  interrupt.textContent = 'Interrupt speech';
  interrupt.setAttribute('aria-label', `Interrupt speech for ${task.title}`);
  interrupt.addEventListener('click', () => {
    void bridge.interruptSpeech().then((result) => {
      wrap.append(note(doc, result.ok ? (result.detail ?? 'Speech interrupted.') : result.reason, 'muted'));
    });
  });
  wrap.append(interrupt);

  const stop = h(doc, 'button', 'btn');
  stop.setAttribute('data-testid', `stop-playback-${task.taskId}`);
  stop.textContent = 'Stop playback';
  stop.setAttribute('aria-label', `Stop playback for ${task.title}`);
  stop.addEventListener('click', () => {
    void bridge.stopPlayback().then((result) => {
      wrap.append(note(doc, result.ok ? (result.detail ?? 'Playback stopped.') : result.reason, 'muted'));
    });
  });
  wrap.append(stop);
  return wrap;
}

function controlBar(doc: Document, state: ChatState, bridge: ChatBridge, refresh: () => void): El {
  const wrap = h(doc, 'section', 'card controls');
  const controls = h(doc, 'div', 'emergency-controls');

  const mute = h(doc, 'button', 'btn btn-ghost');
  mute.setAttribute('data-testid', 'mute-capture');
  mute.textContent = state.mute?.muted === true ? 'Unmute capture' : 'Mute capture';
  mute.setAttribute('data-muted', String(state.mute?.muted === true));
  mute.setAttribute('aria-pressed', String(state.mute?.muted === true));
  mute.addEventListener('click', () => {
    void bridge.muteCapture({ muted: state.mute?.muted !== true }).then(() => refresh());
  });
  controls.append(mute);

  const interrupt = h(doc, 'button', 'btn btn-ghost');
  interrupt.setAttribute('data-testid', 'interrupt-speech');
  interrupt.textContent = 'Interrupt speech';
  interrupt.setAttribute('aria-label', 'Interrupt speech');
  interrupt.addEventListener('click', () => {
    void bridge.interruptSpeech().then(() => refresh());
  });
  controls.append(interrupt);

  const stop = h(doc, 'button', 'btn btn-danger');
  stop.setAttribute('data-testid', 'emergency-stop');
  stop.append(icon(doc, 'stop'));
  const stopLabel = h(doc, 'span');
  stopLabel.textContent = 'Emergency stop';
  stop.append(stopLabel);
  stop.setAttribute('aria-label', 'Emergency stop all work and speech');
  stop.addEventListener('click', () => {
    void bridge.emergencyStop().then(() => refresh());
  });
  controls.append(stop);
  wrap.append(controls);

  const report = state.emergencyStop;
  if (report !== undefined) {
    const feed = h(doc, 'div', 'stop-report');
    feed.append(note(doc, `Engaged: ${report.engaged ? 'yes' : 'no'}.`, 'outcome'));
    if (report.stopped.length > 0) {
      feed.append(note(doc, `Stopped (confirmed): ${report.stopped.join(', ')}`, 'outcome'));
    } else {
      feed.append(note(doc, 'No stops were confirmed.', 'muted'));
    }
    if (report.cancellationUnconfirmed.length > 0) {
      feed.append(
        note(doc, `Cancellation requested, not confirmed: ${report.cancellationUnconfirmed.join(', ')}`, 'muted'),
      );
    }
    if (report.unknown.length > 0) {
      feed.append(note(doc, `Unknown outcome: ${report.unknown.join(', ')}`, 'muted'));
    }
    wrap.append(feed);
  }
  return wrap;
}

function composer(doc: Document, state: ChatState, bridge: ChatBridge, refresh: () => void): El {
  const wrap = h(doc, 'form', 'composer');
  const pending = state.turns.some((turn) => turn.state === 'pending');
  const input = h(doc, 'textarea', 'composer-input');
  input.id = 'composer-input';
  input.rows = 1;
  input.placeholder = 'Message Aria…';
  input.setAttribute('data-testid', 'composer-input');
  input.setAttribute('aria-label', 'Message');

  const autoGrow = (): void => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  };

  const send = h(doc, 'button', 'composer-send');
  send.type = 'submit';
  send.append(icon(doc, 'send'));
  const sendLabel = h(doc, 'span', 'sr-only');
  sendLabel.textContent = 'Send';
  send.append(sendLabel);
  send.setAttribute('data-testid', 'composer-send');
  send.setAttribute('aria-label', 'Send message');

  const hint = h(doc, 'p', 'composer-hint');
  hint.textContent = 'Enter to send · Shift+Enter for a new line · Esc to clear';

  const actions = h(doc, 'div', 'composer-actions');
  actions.append(send);

  // While a reply is in flight, offer a stop control so a long turn is never a
  // dead end. Stopping playback is barge-in, never a task cancellation.
  if (pending) {
    const stop = h(doc, 'button', 'composer-stop');
    stop.type = 'button';
    stop.append(icon(doc, 'stop'));
    const stopLabel = h(doc, 'span', 'sr-only');
    stopLabel.textContent = 'Stop';
    stop.append(stopLabel);
    stop.setAttribute('data-testid', 'composer-stop');
    stop.setAttribute('aria-label', 'Stop generating');
    stop.addEventListener('click', () => {
      void bridge.interruptSpeech().then(() => refresh());
    });
    actions.append(stop);
  }

  wrap.append(input, actions, hint);

  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      input.value = '';
      autoGrow();
      return;
    }
    if (event.key === 'Enter' && (event.shiftKey === false || event.ctrlKey || event.metaKey)) {
      if (event.isComposing) return;
      event.preventDefault();
      wrap.requestSubmit();
    }
  });
  wrap.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = input.value;
    if (value.trim() === '') return;
    input.value = '';
    autoGrow();
    // Paint the user turn and a thinking placeholder at once, so the reply never
    // appears to arrive out of nowhere.
    const optimistic: ChatState = {
      ...state,
      turns: [
        ...state.turns,
        { id: `optimistic-${state.turns.length}`, role: 'user', text: value.trim(), at: new Date().toISOString(), state: 'complete' },
        { id: `pending-${state.turns.length}`, role: 'assistant', text: '', at: new Date().toISOString(), state: 'pending' },
      ],
    };
    renderChat(doc, optimistic, bridge);
    void bridge.sendText(value).then(() => refresh());
  });
  return wrap;
}

function scrollToBottomButton(doc: Document): El {
  const btn = h(doc, 'button', 'to-bottom');
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Scroll to latest');
  btn.append(icon(doc, 'down'));
  btn.addEventListener('click', () => {
    const root = doc.getElementById('chat');
    root?.scrollTo({ top: root.scrollHeight, behavior: 'smooth' });
  });
  return btn;
}

function headerBar(doc: Document): El {
  const header = h(doc, 'header', 'chat-header');
  const brand = h(doc, 'div', 'brand');
  const mark = h(doc, 'span', 'brand-mark');
  mark.append(icon(doc, 'spark'));
  const brandText = h(doc, 'div', 'brand-text');
  const name = h(doc, 'span', 'brand-name');
  name.textContent = 'Aria';
  const status = h(doc, 'span', 'brand-status');
  status.textContent = 'Local-first voice assistant';
  brandText.append(name, status);
  brand.append(mark, brandText);
  header.append(brand);
  return header;
}

export function renderChat(doc: Document, state: ChatState, bridge: ChatBridge): void {
  const root = doc.getElementById('chat');
  if (root === null) return;
  const active = doc.activeElement;
  const focusId = active instanceof HTMLElement ? active.id : '';
  const selectionStart =
    active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
      ? active.selectionStart
      : null;
  const scrollTop = root.scrollTop;
  const atBottom = root.scrollHeight - root.clientHeight - root.scrollTop <= 8;
  // A rebuild replaces the composer node; carry the user's unsent draft across
  // so a background refresh never erases what they are typing.
  const priorInput = doc.getElementById('composer-input');
  const composerValue = priorInput instanceof HTMLTextAreaElement ? priorInput.value : '';

  const refresh = (): void => {
    void bridge.chatState().then((next) => renderChat(doc, next, bridge));
  };

  root.replaceChildren(
    headerBar(doc),
    conversationSection(doc, state, bridge, refresh),
    ...state.tasks.map((task) => taskSection(doc, task, bridge, refresh)),
    controlBar(doc, state, bridge, refresh),
    composer(doc, state, bridge, refresh),
    scrollToBottomButton(doc),
  );

  root.classList.toggle('at-bottom', atBottom);
  // Re-rendering the whole surface would otherwise snap the log back to the top
  // and drop the caret out of the composer on every refresh.
  root.scrollTop = atBottom ? root.scrollHeight : scrollTop;
  const restoredInput = doc.getElementById('composer-input');
  if (restoredInput instanceof HTMLTextAreaElement && composerValue !== '') {
    restoredInput.value = composerValue;
    restoredInput.style.height = 'auto';
    restoredInput.style.height = `${Math.min(restoredInput.scrollHeight, 200)}px`;
  }
  if (focusId !== '') {
    const restored = doc.getElementById(focusId);
    if (restored instanceof HTMLElement) {
      restored.focus();
      if (
        (restored instanceof HTMLInputElement || restored instanceof HTMLTextAreaElement) &&
        selectionStart !== null
      ) {
        restored.setSelectionRange(selectionStart, selectionStart);
      }
    }
  }
}

/**
 * A render key that ignores `generatedAt`: the timestamp advances on every poll
 * even when nothing the user can see has changed, and re-rendering for it alone
 * is what makes the surface feel heavy.
 */
function stateKey(state: ChatState): string {
  const rest: Record<string, unknown> = { ...state };
  delete rest['generatedAt'];
  return JSON.stringify(rest);
}

export function bootstrapChat(doc: Document, bridge: ChatBridge): void {
  const root = doc.getElementById('chat');
  if (root !== null) {
    const loader = h(doc, 'div', 'loading');
    loader.append(typingDots(doc));
    root.replaceChildren(loader);
  }
  let lastKey: string | undefined;
  let pending = false;
  const refresh = (): void => {
    // Skip a tick while the previous read is still in flight, so a slow backend
    // cannot stack concurrent state reads and repaints.
    if (pending) return;
    pending = true;
    void bridge.chatState().then(
      (state) => {
        pending = false;
        const key = stateKey(state);
        if (key === lastKey) return;
        lastKey = key;
        renderChat(doc, state, bridge);
      },
      () => {
        pending = false;
      },
    );
  };
  refresh();
  // Chat is a live surface: task phases, approvals and stop reports change
  // without a user action, so it re-reads its state on an interval instead of
  // rendering once and freezing. The poll is cheap; the render is skipped
  // whenever the state is unchanged, so an idle chat costs nothing.
  const timer = setInterval(refresh, 2000);
  doc.defaultView?.addEventListener('pagehide', () => clearInterval(timer));
}

const injected = (globalThis as { aria?: ChatBridge }).aria;

if (typeof document !== 'undefined' && injected !== undefined) {
  bootstrapChat(document, injected);
}
