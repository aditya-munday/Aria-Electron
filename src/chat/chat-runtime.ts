import type { AriaRuntime } from '../runtime.js';
import type { RouteHint } from '../contract/aria-contract.js';
import type { ApprovalScope, OperationDescriptor } from '../supervisor/approval-scope.js';
import type {
  ApprovalRequestedInput,
  ChatControl,
  ChatRuntime,
  ChatTaskControl,
  SubmittedWork,
} from './chat-service.js';
import type { EmergencyStopView } from './state.js';
import type { CancellationOutcome, ConfirmCancellationOptions } from '../control/cancellation.js';
import { MuteController, type CaptureMode } from '../control/mute.js';
import { StopController } from '../control/stop-controller.js';

export interface ChatControlOptions {
  readonly muted?: boolean;
  readonly mode?: CaptureMode;
  readonly interruptLocal?: () => void;
  readonly persistMute?: (muted: boolean) => void;
}

export function createChatControl(
  runtime: AriaRuntime,
  options: ChatControlOptions = {},
): ChatControl {
  const mute = new MuteController({
    muted: options.muted ?? false,
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
  });
  const stop = new StopController({
    haltLocal: () => {
      options.interruptLocal?.();
      return { captureHalted: true, playbackHalted: true };
    },
    ...(options.interruptLocal !== undefined ? { interruptLocal: options.interruptLocal } : {}),
  });
  const voice = runtime.voice;
  return {
    get muteState(): { readonly muted: boolean; readonly mode: string } {
      return { muted: mute.isMuted(), mode: mute.captureMode().kind };
    },
    setMuted: (muted: boolean): void => {
      if (muted) {
        mute.mute();
        void voice?.muteCapture();
      } else {
        mute.unmute();
      }
      options.persistMute?.(muted);
    },
    interruptSpeech: (): void => {
      stop.interruptSpeech();
      void voice?.interrupt();
    },
    stopPlayback: (): void => {
      stop.stopPlayback();
    },
    engageEmergencyStop: (): void => {
      stop.engage();
    },
  };
}

export function createChatRuntime(
  runtime: AriaRuntime,
  control?: ChatControl,
): ChatRuntime {
  const supervisor = runtime.supervisor;
  const principal = async (): Promise<string> => (await runtime.principal()) ?? 'local';
  const scopes = new Map<string, ApprovalScope>();

  const rememberApproval = async (input: ApprovalRequestedInput): Promise<void> => {
    const who = await principal();
    scopes.set(input.approvalId, {
      approvalId: input.approvalId,
      taskId: input.taskId,
      principal: who,
      operation: input.operation,
      planVersion: input.planVersion,
      granted: true,
    });
  };

  const submit = async (input: {
    title: string;
    conversationId?: string;
  }): Promise<SubmittedWork> => {
    const record = await supervisor.submitRequest({
      title: input.title,
      ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
    });
    const approvals = await supervisor.listApprovals(record.taskId);
    const approvalId = approvals.ok ? (approvals.value[0]?.id ?? '') : '';
    return { record, approvalId };
  };

  const tasks: ChatTaskControl = {
    records: () => supervisor.records(),
    submit,
    reconcile: async (): Promise<void> => {
      await supervisor.reconcile();
    },
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
    cancelAndConfirm: (
      taskId: string,
      options?: ConfirmCancellationOptions,
    ): Promise<CancellationOutcome> => supervisor.cancelAndConfirm(taskId, options),
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
            sendText: (
              text: string,
            ): Promise<{ readonly text: string; readonly route?: RouteHint | null }> => {
              const voice = runtime.voice;
              if (voice === undefined) return Promise.resolve({ text: '' });
              return voice.sendText(text);
            },
          },
    tasks,
    ...(control !== undefined ? { control } : {}),
  };
}

export { type ApprovalScope, type OperationDescriptor };
