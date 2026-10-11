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
      ['error', 'idle', 'listening', 'muted', 'speaking', 'thinking'].sort(),
    );
  });

  it('stamps the presence with the supplied clock', () => {
    expect(resolvePresence(sources()).updatedAt).toBe(NOW);
  });
});
