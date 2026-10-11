import type { TaskPhase } from '../supervisor/supervisor.js';
import type { OperationDescriptor } from '../supervisor/approval-scope.js';

export type ChatRole = 'user' | 'assistant' | 'system';

export type ChatTurnState = 'complete' | 'pending' | 'failed';

export interface ChatTurn {
  readonly id: string;
  readonly role: ChatRole;
  readonly text: string;
  readonly at: string;
  readonly state: ChatTurnState;
  readonly error?: string;
  readonly submittedTaskId?: string;
  readonly routeCapability?: string;
}

export type ApprovalDecision = 'approved' | 'rejected';

export interface ApprovalScopeView {
  readonly capability: string;
  readonly riskTier: string;
  readonly planVersion: number;
  readonly affectedResources: readonly string[];
  readonly expiresAt?: string;
}

export interface ApprovalView {
  readonly approvalId: string;
  readonly taskId: string;
  readonly requestedBy: string;
  readonly createdAt: string;
  readonly decision: ApprovalDecision | null;
  readonly scope: ApprovalScopeView;
}

export interface QuestionView {
  readonly questionId: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly blocking: boolean;
}

export interface PlanView {
  readonly planId: string;
  readonly planVersion: number;
  readonly summary: string;
  readonly operations: readonly string[];
}

export interface PermissionView {
  readonly requestId: string;
  readonly capability: string;
  readonly scope: string;
  readonly summary?: string;
  readonly requiresInteractiveAuth: boolean;
}

export interface TaskResultView {
  readonly outcome: string;
  readonly verification: string;
  readonly confirmed: boolean;
}

export interface ChatTaskView {
  readonly taskId: string;
  readonly title: string;
  readonly phase: TaskPhase;
  readonly status: string;
  readonly progress?: number;
  readonly approval?: ApprovalView;
  readonly questions: readonly QuestionView[];
  readonly plans: readonly PlanView[];
  readonly permissions: readonly PermissionView[];
  readonly result?: TaskResultView;
  readonly updatedAt: string;
}

export interface EmergencyStopView {
  readonly engaged: boolean;
  readonly stopped: readonly string[];
  readonly cancellationUnconfirmed: readonly string[];
  readonly unknown: readonly string[];
  readonly reportedAt: string;
}

export interface ChatState {
  readonly generatedAt: string;
  readonly turns: readonly ChatTurn[];
  readonly tasks: readonly ChatTaskView[];
  readonly emergencyStop?: EmergencyStopView;
}

export interface ChatSources {
  readonly turns: readonly ChatTurn[];
  readonly records: readonly ChatRecordView[];
  readonly emergencyStop: EmergencyStopView | undefined;
  readonly now: string;
}

export interface ChatRecordView {
  readonly taskId: string;
  readonly title: string;
  readonly phase: TaskPhase;
  readonly status: string;
  readonly updatedAt: string;
  readonly progress?: number;
  readonly approvals: readonly ApprovalView[];
  readonly questions: readonly QuestionView[];
  readonly plans: readonly PlanView[];
  readonly permissions: readonly PermissionView[];
  readonly result?: TaskResultView;
}

export type ApprovalDecisionOutcome =
  | {
      readonly ok: true;
      readonly approvalId: string;
      readonly taskId: string;
      readonly decision: ApprovalDecision;
    }
  | {
      readonly ok: false;
      readonly approvalId: string;
      readonly taskId: string;
      readonly reason: string;
      readonly reassessmentRequired: boolean;
    };

export type ChatActionResult =
  | { readonly ok: true; readonly detail?: string; readonly submittedTaskId?: string }
  | { readonly ok: false; readonly reason: string };
