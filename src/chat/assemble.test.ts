import { describe, expect, it } from 'vitest';

import { assembleChatState, emergencyStopView } from './assemble.js';
import type { ChatRecordView, ChatSources, EmergencyStopView } from './state.js';

function record(overrides: Partial<ChatRecordView> = {}): ChatRecordView {
  return {
    taskId: 'task-1',
    title: 'Deploy',
    phase: 'awaiting_approval',
    status: 'accepted',
    updatedAt: '2026-10-13T10:00:00.000Z',
    approvals: [],
    questions: [],
    plans: [],
    permissions: [],
    ...overrides,
  };
}

function sources(overrides: Partial<ChatSources> = {}): ChatSources {
  return {
    turns: [],
    records: [],
    emergencyStop: undefined,
    mute: undefined,
    now: '2026-10-13T10:00:00.000Z',
    ...overrides,
  };
}

describe('assembleChatState', () => {
  it('lists only the approval that is still undecided', () => {
    const state = assembleChatState(
      sources({
        records: [
          record({
            approvals: [
              {
                approvalId: 'a-decided',
                taskId: 'task-1',
                requestedBy: 'worker',
                createdAt: 'x',
                decision: 'approved',
                scope: { capability: 'deploy', riskTier: 'standard', planVersion: 1, affectedResources: [] },
              },
              {
                approvalId: 'a-pending',
                taskId: 'task-1',
                requestedBy: 'worker',
                createdAt: 'x',
                decision: null,
                scope: { capability: 'deploy', riskTier: 'standard', planVersion: 1, affectedResources: [] },
              },
            ],
          }),
        ],
      }),
    );
    expect(state.tasks[0]?.approval?.approvalId).toBe('a-pending');
  });

  it('leaves the approval absent when every approval is decided', () => {
    const state = assembleChatState(sources({ records: [record({ approvals: [] })] }));
    expect(state.tasks[0]?.approval).toBeUndefined();
  });

  it('omits the emergency stop and mute blocks when the sources have none', () => {
    const state = assembleChatState(sources());
    expect(state.emergencyStop).toBeUndefined();
    expect(state.mute).toBeUndefined();
  });

  it('carries the emergency stop and mute through when present', () => {
    const stop: EmergencyStopView = {
      engaged: true,
      stopped: [],
      cancellationUnconfirmed: [],
      unknown: [],
      reportedAt: '2026-10-13T10:00:00.000Z',
    };
    const state = assembleChatState(
      sources({ emergencyStop: stop, mute: { muted: true, mode: 'idle' } }),
    );
    expect(state.emergencyStop).toEqual(stop);
    expect(state.mute).toEqual({ muted: true, mode: 'idle' });
  });

  it('stamps the generated time from the source clock', () => {
    const state = assembleChatState(sources({ now: '2026-01-02T03:04:05.000Z' }));
    expect(state.generatedAt).toBe('2026-01-02T03:04:05.000Z');
  });
});

describe('emergencyStopView', () => {
  it('returns the report unchanged', () => {
    const stop: EmergencyStopView = {
      engaged: true,
      stopped: ['capture'],
      cancellationUnconfirmed: ['task-9'],
      unknown: [],
      reportedAt: 'x',
    };
    expect(emergencyStopView(stop)).toBe(stop);
  });
});
