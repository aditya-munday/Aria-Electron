import { describe, expect, it } from 'vitest';

import { resolvePresence } from './assemble.js';
import { ORB_CUE } from './state.js';

const NOW = '2026-01-01T00:00:00.000Z';

function sources(overrides: Partial<Parameters<typeof resolvePresence>[0]> = {}) {
  return {
    diagnostics: undefined,
    captureMuted: false,
    now: NOW,
    ...overrides,
  };
}

describe('orb presence resolution', () => {
  it('is idle when no voice runtime is available', () => {
    const view = resolvePresence(sources());
    expect(view.presence).toBe('idle');
    expect(view.cue).toBe('dot');
  });

  it('is muted, ahead of any voice state, when capture is muted', () => {
    const view = resolvePresence(
      sources({
        captureMuted: true,
        diagnostics: {
          listening: true,
          sessionState: 'capturing',
          wakeWordEnabled: true,
        },
      }),
    );
    expect(view.presence).toBe('muted');
    expect(view.cue).toBe('slash');
    expect(view.detail).toBeDefined();
  });

  it('is listening while a session is capturing audio', () => {
    const view = resolvePresence(
      sources({
        diagnostics: { listening: true, sessionState: 'capturing', wakeWordEnabled: true },
      }),
    );
    expect(view.presence).toBe('listening');
    expect(view.cue).toBe('waveform');
  });

  it('is thinking, speaking and error as the session state moves', () => {
    const thinking = resolvePresence(
      sources({ diagnostics: { listening: false, sessionState: 'thinking', wakeWordEnabled: true } }),
    );
    const speaking = resolvePresence(
      sources({ diagnostics: { listening: false, sessionState: 'speaking', wakeWordEnabled: true } }),
    );
    const failed = resolvePresence(
      sources({ diagnostics: { listening: false, sessionState: 'failed', wakeWordEnabled: true } }),
    );
    expect(thinking.presence).toBe('thinking');
    expect(speaking.presence).toBe('speaking');
    expect(failed.presence).toBe('error');
  });

  it('surfaces a reported error with its message, not a generic one', () => {
    const view = resolvePresence(
      sources({
        diagnostics: {
          listening: false,
          sessionState: 'idle',
          wakeWordEnabled: true,
          lastError: { kind: 'microphone_denied', message: 'Microphone access was denied.' },
        },
      }),
    );
    expect(view.presence).toBe('error');
    expect(view.detail).toBe('Microphone access was denied.');
  });

  it('covers every presence with a cue', () => {
    expect(Object.keys(ORB_CUE).sort()).toEqual(
      [
        'awaiting_approval',
        'awaiting_input',
        'error',
        'hidden',
        'idle',
        'interrupted',
        'listening',
        'muted',
        'recovering',
        'speaking',
        'task_running',
        'thinking',
      ].sort(),
    );
  });

  it('is interrupted when the voice session was cancelled', () => {
    const view = resolvePresence(
      sources({
        diagnostics: { listening: false, sessionState: 'cancelled', wakeWordEnabled: true },
      }),
    );
    expect(view.presence).toBe('interrupted');
    expect(view.cue).toBe('halt');
    expect(view.detail).toBeDefined();
  });

  it('reflects tracked work: approval, question, running and unknown', () => {
    const task = (overrides: Partial<OrbSources['task']> = {}) => ({
      phase: 'running' as const,
      pendingQuestions: 0,
      pendingPlans: 0,
      pendingPermissions: 0,
      ...overrides,
    });
    const diagnostics = { listening: false, sessionState: 'idle', wakeWordEnabled: true };

    const approval = resolvePresence(
      sources({ diagnostics, task: task({ phase: 'accepted', pendingPlans: 1 }) }),
    );
    const question = resolvePresence(
      sources({ diagnostics, task: task({ phase: 'accepted', pendingQuestions: 1 }) }),
    );
    const running = resolvePresence(sources({ diagnostics, task: task() }));
    const unknown = resolvePresence(sources({ diagnostics, task: task({ phase: 'unknown' }) }));

    expect(approval.presence).toBe('awaiting_approval');
    expect(question.presence).toBe('awaiting_input');
    expect(running.presence).toBe('task_running');
    expect(unknown.presence).toBe('recovering');
  });

  it('lets an active voice session outrank background task state', () => {
    const view = resolvePresence(
      sources({
        diagnostics: { listening: true, sessionState: 'capturing', wakeWordEnabled: true },
        task: {
          phase: 'running',
          pendingQuestions: 0,
          pendingPlans: 0,
          pendingPermissions: 0,
        },
      }),
    );
    expect(view.presence).toBe('listening');
  });

  it('stamps the presence with the supplied clock', () => {
    expect(resolvePresence(sources()).updatedAt).toBe(NOW);
  });

  it('does not advertise wake listening when detection is disabled', () => {
    const view = resolvePresence(
      sources({ diagnostics: { listening: true, sessionState: 'idle', wakeWordEnabled: false } }),
    );
    expect(view.presence).toBe('idle');
  });
});
