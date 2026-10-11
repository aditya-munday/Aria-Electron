import type { AriaRuntime } from '../runtime.js';
import type { ApprovalScope, OperationDescriptor } from '../supervisor/approval-scope.js';
import type { ApprovalRequestedInput, ChatRuntime, ChatTaskControl } from './chat-service.js';
import type { EmergencyStopView } from './state.js';

export function createChatRuntime(runtime: AriaRuntime): ChatRuntime {
  const supervisor = runtime.supervisor;
  const principal = async (): Promise<string> => (await runtime.principal()) ?? 'local';
  const scopes = new Map<string, ApprovalScope>();

  const rememberApproval = (input: ApprovalRequestedInput): void => {
    void principal().then((who) => {
      scopes.set(input.approvalId, {
        approvalId: input.approvalId,
        taskId: input.taskId,
        principal: who,
        operation: input.operation,
        planVersion: input.planVersion,
        granted: true,
      });
    });
  };

  const tasks: ChatTaskControl = {
    records: () => supervisor.records(),
    approvals: (taskId) => supervisor.listApprovals(taskId),
    approvalScope: (approvalId) => scopes.get(approvalId),
    rememberApproval,
    decideApproval: (taskId, approvalId, decision, reason) =>
      supervisor.decideApproval(taskId, approvalId, decision, reason),
    answerQuestion: (taskId, questionId, answer) =>
      supervisor.answerQuestion(taskId, questionId, answer),
    decidePlan: (taskId, plan, decision, reason) =>
      supervisor.decidePlan(taskId, plan, decision, reason),
    decidePermission: (taskId, requestId, decision, reason) =>
      supervisor.decidePermission(taskId, requestId, decision, reason),
    cancel: (taskId) => supervisor.cancel(taskId),
    emergencyStop: async (): Promise<EmergencyStopView> => {
      const report = await supervisor.emergencyStopNow();
      return {
        engaged: report.engaged,
        stopped: report.stopped,
        cancellationUnconfirmed: report.cancellationUnconfirmed,
        unknown: report.unknown,
        reportedAt: new Date().toISOString(),
      };
    },
  };

  return {
    voice:
      runtime.voice === undefined
        ? undefined
        : {
            sendText: (text: string): Promise<void> =>
              runtime.voice?.sendText(text) ?? Promise.resolve(),
          },
    tasks,
  };
}

export { type ApprovalScope, type OperationDescriptor };
