import { describe, expect, it } from 'vitest';

import { isOrbPresence, ORB_CUE, ORB_LABEL, type OrbPresence } from './state.js';

const PRESENCES: readonly OrbPresence[] = [
  'hidden',
  'idle',
  'listening',
  'thinking',
  'speaking',
  'interrupted',
  'awaiting_approval',
  'awaiting_input',
  'task_running',
  'recovering',
  'error',
  'muted',
];

describe('Orb presence tables', () => {
  it('assigns every presence a cue and a label', () => {
    for (const presence of PRESENCES) {
      expect(ORB_CUE[presence]).toBeTruthy();
      expect(ORB_LABEL[presence]).toBeTruthy();
    }
  });

  it('gives distinct presences distinct cues so the Orb is never ambiguous', () => {
    const cues = PRESENCES.map((presence) => ORB_CUE[presence]);
    expect(new Set(cues).size).toBe(cues.length);
  });
});

describe('isOrbPresence', () => {
  it('accepts a known presence', () => {
    expect(isOrbPresence('listening')).toBe(true);
  });

  it('rejects an unknown or inherited key', () => {
    expect(isOrbPresence('dancing')).toBe(false);
    expect(isOrbPresence('toString')).toBe(false);
  });
});
