import type { ChatSources, ChatState, ChatTaskView, EmergencyStopView } from './state.js';

export function assembleChatState(sources: ChatSources): ChatState {
  const tasks = sources.records.map(toTaskView);
  return {
    generatedAt: sources.now,
    turns: [...sources.turns],
    tasks,
    ...(sources.emergencyStop !== undefined ? { emergencyStop: sources.emergencyStop } : {}),
  };
}

function toTaskView(record: ChatSources['records'][number]): ChatTaskView {
  const pending = record.approvals.find((approval) => approval.decision === null);
  return {
    taskId: record.taskId,
    title: record.title,
    phase: record.phase,
    status: record.status,
    ...(record.progress !== undefined ? { progress: record.progress } : {}),
    ...(pending !== undefined ? { approval: pending } : {}),
    questions: record.questions,
    plans: record.plans,
    permissions: record.permissions,
    ...(record.result !== undefined ? { result: record.result } : {}),
    updatedAt: record.updatedAt,
  };
}

export function emergencyStopView(report: EmergencyStopView): EmergencyStopView {
  return report;
}
