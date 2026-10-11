import type { ApprovalDto, ExecutionResultDto } from '../contract/product-contract.js';
import type { Result } from '../backend/result.js';
import {
  assertApprovalScope,
  type ApprovalScope,
  type OperationDescriptor,
} from '../supervisor/approval-scope.js';
import { describeTaskPhase } from '../supervisor/supervisor.js';
import type { SupervisionRecord } from '../supervisor/task-store.js';
import { assembleChatState, emergencyStopView } from './assemble.js';
import { deriveTitle, operationForRoute, shouldSubmit } from './submission.js';
import { describeCancellation } from '../control/cancellation.js';
import type { CancellationOutcome, ConfirmCancellationOptions } from '../control/cancellation.js';
import type { RouteHint } from '../contract/aria-contract.js';
import type {
  ApprovalDecisionOutcome,
  ApprovalView,
  ChatActionResult,
  ChatRecordView,
  ChatState,
  ChatTurn,
  EmergencyStopView,
  TaskResultView,
} from './state.js';

export interface ApprovalRequestedInput {
  readonly approvalId: string;
  readonly taskId: string;
  readonly planVersion: number;
  readonly operation: OperationDescriptor;
}

export interface SubmittedWork {
  readonly record: SupervisionRecord;
  readonly approvalId: string;
}

export interface ChatVoiceControl {
  sendText(text: string): Promise<{ readonly text: string; readonly route?: RouteHint | null }>;
}

export interface ChatControl {
  readonly muteState: { readonly muted: boolean; readonly mode: string };
  setMuted(muted: boolean): void;
  interruptSpeech(): void;
  stopPlayback(): void;
  engageEmergencyStop(): void;
}

export interface ChatTaskControl {
  records(): readonly SupervisionRecord[];
  submit(input: { title: string; conversationId?: string }): Promise<SubmittedWork>;
  reconcile(): Promise<void>;
  approvals(taskId: string): Promise<Result<readonly ApprovalDto[]>>;
  approvalScope(approvalId: string): ApprovalScope | undefined;
  rememberApproval(input: ApprovalRequestedInput): Promise<void>;
  decideApproval(
    taskId: string,
    approvalId: string,
    decision: 'approved' | 'rejected',
    reason?: string,
  ): Promise<SupervisionRecord | undefined>;
  answerQuestion(taskId: string, questionId: string, answer: string): Promise<void>;
  decidePlan(
    taskId: string,
    plan: { planId: string; planVersion: number },
    decision: 'accepted' | 'rejected',
    reason?: string,
  ): Promise<void>;
  decidePermission(
    taskId: string,
    requestId: string,
    decision: 'granted' | 'denied',
    reason?: string,
  ): Promise<void>;
  cancel(taskId: string): Promise<SupervisionRecord | undefined>;
  cancelAndConfirm(
    taskId: string,
    options?: ConfirmCancellationOptions,
  ): Promise<CancellationOutcome>;
  emergencyStop(): Promise<EmergencyStopView>;
}

export interface ChatRuntime {
  voice: ChatVoiceControl | undefined;
  tasks: ChatTaskControl;
  control?: ChatControl;
}

export interface ChatDeps {
  readonly runtime: ChatRuntime;
  readonly principal: () => string | Promise<string>;
  readonly now?: () => string;
}

export class ChatService {
  private readonly deps: ChatDeps;
  private readonly now: () => string;
  private readonly turns: ChatTurn[] = [];
  private turnCounter = 0;
  private emergency: EmergencyStopView | undefined;

  constructor(deps: ChatDeps) {
    this.deps = deps;
    this.now = deps.now ?? ((): string => new Date().toISOString());
  }

  async buildState(): Promise<ChatState> {
    await this.deps.runtime.tasks.reconcile();
    const now = this.now();
    const records = await this.recordViews();
    const mute = this.deps.runtime.control?.muteState;
    return assembleChatState({
      turns: this.turns,
      records,
      emergencyStop: this.emergency,
      mute:
        mute !== undefined ? { muted: mute.muted, mode: mute.mode } : undefined,
      now,
    });
  }

  /**
   * Submit a typed turn. It never opens the microphone. When the reply carries
   * an advisory route hint that requires confirmation, the turn is also
   * submitted as tracked work — accepted and awaiting approval, not running.
   */
  async sendText(text: string): Promise<ChatActionResult> {
    const trimmed = text.trim();
    if (trimmed === '') return { ok: false, reason: 'A message cannot be empty.' };
    const voice = this.deps.runtime.voice;
    if (voice === undefined) {
      return { ok: false, reason: 'Typed conversation is unavailable on this build.' };
    }
    const userTurn: ChatTurn = {
      id: this.nextTurnId(),
      role: 'user',
      text: trimmed,
      at: this.now(),
      state: 'complete',
    };
    this.turns.push(userTurn);

    let reply: { readonly text: string; readonly route?: RouteHint | null };
    try {
      reply = await voice.sendText(trimmed);
    } catch (error) {
      const failed: ChatTurn = { ...userTurn, state: 'failed', error: messageOf(error) };
      this.turns[this.turns.length - 1] = failed;
      return { ok: false, reason: failed.error ?? 'The turn failed.' };
    }

    if (reply.text.trim() !== '') {
      this.turns.push({
        id: this.nextTurnId(),
        role: 'assistant',
        text: reply.text,
        at: this.now(),
        state: 'complete',
      });
    }

    if (!shouldSubmit(reply.route)) return { ok: true };

    const route = reply.route as RouteHint;
    try {
      const submittedWork = await this.deps.runtime.tasks.submit({
        title: deriveTitle(trimmed),
        conversationId: userTurn.id,
      });
      await this.rememberApprovalFor(submittedWork, route);
      const submitted: ChatTurn = {
        ...userTurn,
        submittedTaskId: submittedWork.record.taskId,
        routeCapability: route.capability,
      };
      this.replaceTurn(userTurn.id, submitted);
      return { ok: true, submittedTaskId: submittedWork.record.taskId };
    } catch (error) {
      return {
        ok: false,
        reason: `The request was not submitted as tracked work: ${messageOf(error)}`,
      };
    }
  }

  /**
   * Decide an approval. The decision authorizes exactly the operation the
   * approval was issued for. If the operation has materially changed — or the
   * approval is for another task, principal, plan version, or expired — the
   * decision is refused and reassessment is required; nothing is approved.
   */
  async decideApproval(input: unknown): Promise<ApprovalDecisionOutcome> {
    const parsed = parseApprovalDecision(input);
    if (parsed === undefined) {
      return {
        ok: false,
        approvalId: '',
        taskId: '',
        reason: 'The approval decision was malformed.',
        reassessmentRequired: false,
      };
    }
    const scope = this.deps.runtime.tasks.approvalScope(parsed.approvalId);
    if (scope === undefined) {
      return {
        ok: false,
        approvalId: parsed.approvalId,
        taskId: parsed.taskId,
        reason: 'The approval is no longer pending.',
        reassessmentRequired: true,
      };
    }
    const checked = assertApprovalScope(
      scope,
      {
        taskId: parsed.taskId,
        principal: await this.deps.principal(),
        operation: parsed.operation,
        planVersion: parsed.planVersion,
      },
      { now: this.now() },
    );
    if (!checked.ok) {
      return {
        ok: false,
        approvalId: parsed.approvalId,
        taskId: parsed.taskId,
        reason: describeScopeFailure(checked.reason),
        reassessmentRequired: true,
      };
    }
    try {
      await this.deps.runtime.tasks.decideApproval(
        parsed.taskId,
        parsed.approvalId,
        parsed.decision,
      );
    } catch (error) {
      return {
        ok: false,
        approvalId: parsed.approvalId,
        taskId: parsed.taskId,
        reason: messageOf(error),
        reassessmentRequired: false,
      };
    }
    return {
      ok: true,
      approvalId: parsed.approvalId,
      taskId: parsed.taskId,
      decision: parsed.decision,
    };
  }

  async answerQuestion(input: unknown): Promise<ChatActionResult> {
    const parsed = parseQuestionAnswer(input);
    if (parsed === undefined) return { ok: false, reason: 'The answer was malformed.' };
    return this.run(() =>
      this.deps.runtime.tasks.answerQuestion(parsed.taskId, parsed.questionId, parsed.answer),
    );
  }

  async decidePlan(input: unknown): Promise<ChatActionResult> {
    const parsed = parsePlanDecision(input);
    if (parsed === undefined) return { ok: false, reason: 'The plan decision was malformed.' };
    return this.run(() =>
      this.deps.runtime.tasks.decidePlan(
        parsed.taskId,
        { planId: parsed.planId, planVersion: parsed.planVersion },
        parsed.decision,
        parsed.reason,
      ),
    );
  }

  async decidePermission(input: unknown): Promise<ChatActionResult> {
    const parsed = parsePermissionDecision(input);
    if (parsed === undefined) return { ok: false, reason: 'The permission decision was malformed.' };
    return this.run(() =>
      this.deps.runtime.tasks.decidePermission(
        parsed.taskId,
        parsed.requestId,
        parsed.decision,
        parsed.reason,
      ),
    );
  }

  async cancelTask(input: unknown): Promise<ChatActionResult> {
    const taskId = parseTaskId(input);
    if (taskId === undefined) return { ok: false, reason: 'The task was malformed.' };
    try {
      const outcome = await this.deps.runtime.tasks.cancelAndConfirm(taskId);
      if (outcome.kind === 'confirmed') {
        return { ok: true, detail: 'Cancelled: the worker confirmed the stop.' };
      }
      return { ok: false, reason: describeCancellation(outcome) };
    } catch (error) {
      return { ok: false, reason: messageOf(error) };
    }
  }

  muteCapture(muted: boolean): ChatActionResult {
    const control = this.deps.runtime.control;
    if (control === undefined) {
      return { ok: false, reason: 'Capture mute is unavailable on this build.' };
    }
    control.setMuted(muted);
    return { ok: true, detail: muted ? 'Capture muted.' : 'Capture unmuted.' };
  }

  interruptSpeech(): ChatActionResult {
    const control = this.deps.runtime.control;
    if (control === undefined) {
      return { ok: false, reason: 'Speech control is unavailable on this build.' };
    }
    control.interruptSpeech();
    return { ok: true, detail: 'Speech interrupted.' };
  }

  stopPlayback(): ChatActionResult {
    const control = this.deps.runtime.control;
    if (control === undefined) {
      return { ok: false, reason: 'Playback control is unavailable on this build.' };
    }
    control.stopPlayback();
    return { ok: true, detail: 'Playback stopped.' };
  }

  /** Emergency stop. Engages the local halt first, then reports only confirmed stops. */
  async emergencyStop(): Promise<EmergencyStopView> {
    this.deps.runtime.control?.engageEmergencyStop();
    const report = await this.deps.runtime.tasks.emergencyStop();
    this.emergency = emergencyStopView(report);
    return this.emergency;
  }

  private async run(action: () => Promise<void>): Promise<ChatActionResult> {
    try {
      await action();
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: messageOf(error) };
    }
  }

  private nextTurnId(): string {
    this.turnCounter += 1;
    return `turn-${this.turnCounter}`;
  }

  private replaceTurn(id: string, next: ChatTurn): void {
    const index = this.turns.findIndex((turn) => turn.id === id);
    if (index >= 0) this.turns[index] = next;
  }

  private async rememberApprovalFor(submitted: SubmittedWork, route: RouteHint): Promise<void> {
    await this.deps.runtime.tasks.rememberApproval({
      approvalId: submitted.approvalId,
      taskId: submitted.record.taskId,
      planVersion: 1,
      operation: operationForRoute(route),
    });
  }

  private async recordViews(): Promise<readonly ChatRecordView[]> {
    const records = [...this.deps.runtime.tasks.records()].sort((a, b) =>
      a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
    );
    const views: ChatRecordView[] = [];
    for (const record of records) {
      views.push(await this.recordView(record));
    }
    return views;
  }

  private async recordView(record: SupervisionRecord): Promise<ChatRecordView> {
    const approvals = await this.approvalViews(record.taskId);
    return {
      taskId: record.taskId,
      title: record.title,
      phase: describeTaskPhase(record),
      status: record.status,
      updatedAt: record.updatedAt,
      ...(record.progress?.percent !== undefined ? { progress: record.progress.percent } : {}),
      approvals,
      questions: record.pendingQuestions.map((q) => ({
        questionId: q.questionId,
        question: q.question,
        options: q.options,
        blocking: q.blocking,
      })),
      plans: record.pendingPlans.map((p) => ({
        planId: p.planId,
        planVersion: p.planVersion,
        summary: p.summary,
        operations: p.operations.map((op) => op.capability),
      })),
      permissions: record.pendingPermissions.map((p) => ({
        requestId: p.requestId,
        capability: p.capability,
        scope: p.scope,
        ...(p.summary !== undefined ? { summary: p.summary } : {}),
        requiresInteractiveAuth: p.requiresInteractiveAuth,
      })),
      ...(record.result !== undefined
        ? { result: resultView(record.result, record.verification) }
        : {}),
    };
  }

  private async approvalViews(taskId: string): Promise<readonly ApprovalView[]> {
    const listed = await this.deps.runtime.tasks.approvals(taskId);
    if (!listed.ok) return [];
    return listed.value.map((approval) => this.approvalView(approval));
  }

  private approvalView(approval: ApprovalDto): ApprovalView {
    const scope = this.deps.runtime.tasks.approvalScope(approval.id);
    const operation = scope?.operation;
    return {
      approvalId: approval.id,
      taskId: approval.taskId,
      requestedBy: approval.requestedBy,
      createdAt: approval.createdAt,
      decision: approval.decision,
      scope: {
        capability: operation?.capability ?? 'task.dispatch',
        planVersion: scope?.planVersion ?? 1,
        affectedResources: operation?.affectedResources ?? [],
        riskTier: operation?.riskTier ?? 'standard',
      },
    };
  }
}

function resultView(result: ExecutionResultDto, verification: string): TaskResultView {
  return {
    outcome: result.outcome,
    verification,
    confirmed: verification === 'confirmed' && result.outcome === 'succeeded',
  };
}

function describeScopeFailure(reason: string): string {
  switch (reason) {
    case 'material_change':
      return 'The operation changed since this approval was requested; reassessment is required.';
    case 'wrong_plan_version':
      return 'The plan advanced past this approval; reassessment is required.';
    case 'expired':
      return 'This approval expired; reassessment is required.';
    default:
      return 'This approval does not cover the requested operation; reassessment is required.';
  }
}

interface ParsedApprovalDecision {
  readonly approvalId: string;
  readonly taskId: string;
  readonly planVersion: number;
  readonly operation: OperationDescriptor;
  readonly decision: 'approved' | 'rejected';
}

function parseApprovalDecision(value: unknown): ParsedApprovalDecision | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const approvalId = stringOf(record['approvalId']);
  const taskId = stringOf(record['taskId']);
  const decision = record['decision'];
  const planVersion = numberOr(record['planVersion'], 1);
  const operation = operationOf(record['operation']);
  if (approvalId === undefined || taskId === undefined || operation === undefined) return undefined;
  if (decision !== 'approved' && decision !== 'rejected') return undefined;
  return { approvalId, taskId, planVersion, operation, decision };
}

function operationOf(value: unknown): OperationDescriptor | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const capability = stringOf(record['capability']);
  if (capability === undefined) return undefined;
  const privilege = record['privilege'];
  return {
    capability,
    parameters: parametersOf(record['parameters']),
    privilege: privilege === 'admin' || privilege === 'root' ? privilege : 'user',
    riskTier: stringOf(record['riskTier']) ?? 'standard',
    affectedResources: stringListOf(record['affectedResources']),
  };
}

function parametersOf(value: unknown): Readonly<Record<string, string | number | boolean>> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
      out[key] = entry;
    }
  }
  return out;
}

function parseQuestionAnswer(
  value: unknown,
): { taskId: string; questionId: string; answer: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const taskId = stringOf(record['taskId']);
  const questionId = stringOf(record['questionId']);
  const answer = stringOf(record['answer']);
  if (taskId === undefined || questionId === undefined || answer === undefined) return undefined;
  return { taskId, questionId, answer: answer.trim() };
}

interface ParsedPlanDecision {
  readonly taskId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly decision: 'accepted' | 'rejected';
  readonly reason?: string;
}

function parsePlanDecision(value: unknown): ParsedPlanDecision | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const taskId = stringOf(record['taskId']);
  const planId = stringOf(record['planId']);
  const planVersion = typeof record['planVersion'] === 'number' ? record['planVersion'] : undefined;
  const decision = record['decision'];
  if (taskId === undefined || planId === undefined || planVersion === undefined) return undefined;
  if (decision !== 'accepted' && decision !== 'rejected') return undefined;
  const reason = stringOf(record['reason']);
  return { taskId, planId, planVersion, decision, ...(reason !== undefined ? { reason } : {}) };
}

interface ParsedPermissionDecision {
  readonly taskId: string;
  readonly requestId: string;
  readonly decision: 'granted' | 'denied';
  readonly reason?: string;
}

function parsePermissionDecision(value: unknown): ParsedPermissionDecision | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const taskId = stringOf(record['taskId']);
  const requestId = stringOf(record['requestId']);
  const decision = record['decision'];
  if (taskId === undefined || requestId === undefined) return undefined;
  if (decision !== 'granted' && decision !== 'denied') return undefined;
  const reason = stringOf(record['reason']);
  return { taskId, requestId, decision, ...(reason !== undefined ? { reason } : {}) };
}

function parseTaskId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return stringOf((value as Record<string, unknown>)['taskId']);
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringListOf(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The action failed.';
}
