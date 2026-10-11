// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { renderOrb } from './orb.js';
import type { OrbState } from '../state.js';

function state(overrides: Partial<OrbState['presence']> = {}): OrbState {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    presence: {
      presence: 'idle',
      cue: 'dot',
      label: 'Idle',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    },
  };
}

function render(value: OrbState): HTMLElement {
  document.body.innerHTML = '<main id="orb"></main>';
  renderOrb(document, value);
  return document.getElementById('orb') as HTMLElement;
}

describe('orb renderer', () => {
  it('renders the presence label and cue as data attributes', () => {
    const root = render(state());
    const orb = root.querySelector('.orb') as HTMLElement;
    expect(orb.getAttribute('data-presence')).toBe('idle');
    expect(orb.getAttribute('data-cue')).toBe('dot');
    expect(root.querySelector('[data-testid="orb-label"]')?.textContent).toBe('Idle');
  });

  it('renders the listening waveform cue', () => {
    const root = render(state({ presence: 'listening', cue: 'waveform', label: 'Listening' }));
    const orb = root.querySelector('.orb') as HTMLElement;
    expect(orb.getAttribute('data-cue')).toBe('waveform');
    expect(root.querySelector('.cue-waveform')).not.toBeNull();
  });

  it('renders the error cue and its detail', () => {
    const root = render(
      state({
        presence: 'error',
        cue: 'alert',
        label: 'Error',
        detail: 'Microphone access was denied.',
      }),
    );
    expect(root.querySelector('.cue-alert')).not.toBeNull();
    expect(root.querySelector('[data-testid="orb-detail"]')?.textContent).toBe('Microphone access was denied.');
  });

  it('renders the muted slash cue', () => {
    const root = render(state({ presence: 'muted', cue: 'slash', label: 'Muted' }));
    const orb = root.querySelector('.orb') as HTMLElement;
    expect(orb.getAttribute('data-cue')).toBe('slash');
    expect(root.querySelector('.cue-slash')).not.toBeNull();
  });

  it('exposes an accessible label combining the presence and detail', () => {
    const root = render(state({ presence: 'thinking', cue: 'pulse', label: 'Thinking' }));
    const orb = root.querySelector('.orb') as HTMLElement;
    expect(orb.getAttribute('role')).toBe('img');
    expect(orb.getAttribute('aria-label')).toContain('Thinking');
  });
});
