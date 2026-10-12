import { describe, expect, it } from 'vitest';

import { OrbService, summarizeTask } from './orb-service.js';
import type { SupervisionRecord } from '../supervisor/supervisor.js';
import type { OrbRuntime } from './orb-service.js';
import { DEFAULT_SETTINGS } from '../shell/settings.js';

function record(overrides: Partial<SupervisionRecord> = {}): SupervisionRecord {
  return {
    taskId: 't1',
    title: 'Fix the graphics driver',
    status: 'running',
    version: 1,
    origin: 'aria',
    executionState: 'running',
    cancellation: 'none',
    verification: 'unverified',
    lastSequence: 1,
    pendingQuestions: [],
    pendingPermissions: [],
    pendingPlans: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('summarizeTask', () => {
  it('is undefined with no records', () => {
    expect(summarizeTask([])).toBeUndefined();
  });

  it('counts the pending signals the Orb needs to surface', () => {
    const view = summarizeTask([
      record({
        pendingQuestions: [
          { kind: 'question', questionId: 'q1', question: 'Which driver?', options: [], blocking: true },
        ],
        pendingPlans: [
          {
            kind: 'plan_proposed',
            planId: 'p1',
            planVersion: 1,
            summary: 'Reinstall driver',
            operations: [{ capability: 'kernel.param.set' }],
          },
        ],
        pendingPermissions: [
          {
            kind: 'permission_requested',
            requestId: 'r1',
            capability: 'kernel.param.set',
            scope: 'task',
            requiresInteractiveAuth: true,
          },
        ],
      }),
    ]);
    expect(view?.pendingQuestions).toBe(1);
    expect(view?.pendingPlans).toBe(1);
    expect(view?.pendingPermissions).toBe(1);
  });

  it('keeps the most urgent phase across tasks (unknown over failed over running)', () => {
    const notStarted = summarizeTask([record({ executionState: undefined, status: 'queued' })]);
    expect(notStarted?.phase).toBe('not_started');

    const mixed = summarizeTask([
      record({ taskId: 'a', executionState: 'running' }),
      record({ taskId: 'b', executionState: 'failed', status: 'failed' }),
    ]);
    expect(mixed?.phase).toBe('failed');

    const unknownOutranksFailed = summarizeTask([
      record({ taskId: 'a', executionState: 'failed', status: 'failed' }),
      record({
        taskId: 'b',
        executionState: 'leased',
        cancellation: 'requested',
      }),
    ]);
    expect(unknownOutranksFailed?.phase).toBe('cancellation_unconfirmed');
  });
});

describe('OrbService.buildState', () => {
  function runtime(overrides: Partial<OrbRuntime> = {}): OrbRuntime {
    return {
      voiceDiagnostics: () => ({ listening: false, sessionState: 'idle', wakeWordEnabled: true }),
      settings: () => DEFAULT_SETTINGS,
      records: () => [],
      orbVisible: () => true,
      ...overrides,
    };
  }

  it('reports hidden with no cue when the Orb surface is not shown', () => {
    const service = new OrbService({ runtime: runtime({ orbVisible: () => false }) });
    const state = service.buildState();
    expect(state.presence.presence).toBe('hidden');
    expect(state.presence.cue).toBe('none');
  });

  it('reflects the live presence when the Orb is shown', () => {
    const service = new OrbService({ runtime: runtime() });
    expect(service.buildState().presence.presence).toBe('idle');
  });

  it('surfaces a running task on the Orb without a voice session', () => {
    const service = new OrbService({
      runtime: runtime({ records: () => [record({ executionState: 'running' })] }),
    });
    expect(service.buildState().presence.presence).toBe('task_running');
  });
});
