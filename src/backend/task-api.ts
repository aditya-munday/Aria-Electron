/**
 * The task API surface the supervisor depends on.
 *
 * The supervisor is written against this interface rather than the concrete
 * `TaskClient`, so a test can drive it with a real, stateful implementation of
 * the same contract (an in-memory backend that enforces the same lifecycle
 * rules) instead of mocking the client. `TaskClient` is the production
 * implementation.
 */

import type {
  ApprovalDto,
  ApprovalResultEnvelope,
  TaskDto,
  TaskEventDto,
  TaskExecutionDto,
  TaskStatus,
} from '../contract/product-contract.js';
import type { Result } from './result.js';

export interface TaskApi {
  identity(): Promise<Result<{ userId: string }>>;
  createTask(input: { title: string }): Promise<Result<TaskDto>>;
  getTask(taskId: string): Promise<Result<TaskDto>>;
  transitionTask(
    taskId: string,
    input: { status: TaskStatus; expectedVersion: number },
  ): Promise<Result<TaskDto>>;
  requestApproval(taskId: string): Promise<Result<ApprovalResultEnvelope>>;
  decideApproval(
    approvalId: string,
    decision: 'approved' | 'rejected',
    reason?: string,
  ): Promise<Result<ApprovalResultEnvelope>>;
  listTaskApprovals(taskId: string): Promise<Result<readonly ApprovalDto[]>>;
  dispatch(
    taskId: string,
    input?: { origin?: 'cli' | 'website' | 'aria' | 'desktop' | 'gui'; idempotencyKey?: string },
  ): Promise<Result<TaskExecutionDto>>;
  getExecution(taskId: string): Promise<Result<TaskExecutionDto>>;
  requestCancellation(taskId: string): Promise<Result<TaskExecutionDto>>;
  listEvents(taskId: string, sinceSequence?: number): Promise<Result<readonly TaskEventDto[]>>;
  appendEvent(
    taskId: string,
    input: { type: string; idempotencyKey: string; payload?: Record<string, unknown> },
  ): Promise<Result<TaskEventDto>>;
}
