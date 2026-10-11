// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { renderOrb, wirePointerInteractivity, bootstrapOrb, type OrbBridge } from './orb.js';
import type { OrbState } from '../state.js';
import { ORB_WINDOW_SIZE } from '../window-options.js';

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

function bridge(): OrbBridge & { interactivity: boolean[] } {
  const interactivity: boolean[] = [];
  return {
    interactivity,
    orbState: async () => state(),
    orbSetInteractive: async (interactive: boolean) => {
      interactivity.push(interactive);
    },
  };
}

function move(x: number, y: number): void {
  document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y }));
}

describe('orb renderer', () => {
  it('renders the presence label and cue as data attributes', () => {
    const root = render(state());
    const orb = root.querySelector('.orb') as HTMLElement;
    expect(orb.getAttribute('data-presence')).toBe('idle');
    expect(orb.getAttribute('data-cue')).toBe('dot');
    expect(root.querySelector('[data-testid="orb-label"]')?.textContent).toBe('Idle');
  });

  it('draws a single circle: a core with a halo and glow, no frame elements', () => {
    const root = render(state());
    expect(root.querySelectorAll('.core')).toHaveLength(1);
    expect(root.querySelectorAll('.halo')).toHaveLength(1);
    expect(root.querySelectorAll('.glow')).toHaveLength(1);
    expect(root.querySelectorAll('.ring')).toHaveLength(1);
    expect(root.querySelector('.panel')).toBeNull();
    expect(root.querySelector('.frame')).toBeNull();
  });

  it('renders the listening waveform cue as a core', () => {
    const root = render(state({ presence: 'listening', cue: 'waveform', label: 'Listening' }));
    const orb = root.querySelector('.orb') as HTMLElement;
    expect(orb.getAttribute('data-cue')).toBe('waveform');
    expect(root.querySelector('.core-waveform')).not.toBeNull();
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
    expect(root.querySelector('.core-alert')).not.toBeNull();
    expect(root.querySelector('[data-testid="orb-detail"]')?.textContent).toBe('Microphone access was denied.');
  });

  it('renders the muted slash cue', () => {
    const root = render(state({ presence: 'muted', cue: 'slash', label: 'Muted' }));
    const orb = root.querySelector('.orb') as HTMLElement;
    expect(orb.getAttribute('data-cue')).toBe('slash');
    expect(root.querySelector('.core-slash')).not.toBeNull();
  });

  it('exposes an accessible label combining the presence and detail', () => {
    const root = render(state({ presence: 'thinking', cue: 'pulse', label: 'Thinking' }));
    const orb = root.querySelector('.orb') as HTMLElement;
    expect(orb.getAttribute('role')).toBe('img');
    expect(orb.getAttribute('aria-label')).toContain('Thinking');
  });
});

describe('orb pointer interactivity', () => {
  it('accepts pointer input only inside the painted circle', () => {
    document.body.innerHTML = '<main id="orb"></main>';
    const b = bridge();
    wirePointerInteractivity(document, b);
    const center = ORB_WINDOW_SIZE / 2;
    move(center, center);
    expect(b.interactivity).toEqual([true]);
    move(4, 4);
    expect(b.interactivity).toEqual([true, false]);
  });

  it('does not re-emit when the pointer stays inside the circle', () => {
    document.body.innerHTML = '<main id="orb"></main>';
    const b = bridge();
    wirePointerInteractivity(document, b);
    const center = ORB_WINDOW_SIZE / 2;
    move(center, center);
    move(center + 2, center + 2);
    expect(b.interactivity).toEqual([true]);
  });

  it('falls through again when the pointer leaves the window', () => {
    document.body.innerHTML = '<main id="orb"></main>';
    const b = bridge();
    wirePointerInteractivity(document, b);
    const center = ORB_WINDOW_SIZE / 2;
    move(center, center);
    document.dispatchEvent(new MouseEvent('mouseleave'));
    expect(b.interactivity).toEqual([true, false]);
  });
});

describe('orb live presence', () => {
  it('re-reads its state on an interval so a new presence appears without reopening', async () => {
    vi.useFakeTimers();
    try {
      document.body.innerHTML = '<main id="orb"></main>';
      let presence: OrbState['presence'] = {
        presence: 'idle',
        cue: 'dot',
        label: 'Idle',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      const b: OrbBridge = {
        orbState: async () => ({ generatedAt: 'now', presence }),
        orbSetInteractive: async () => undefined,
      };
      const stop = bootstrapOrb(document, b, 100);
      await vi.advanceTimersByTimeAsync(0);
      expect(document.querySelector('.orb')?.getAttribute('data-presence')).toBe('idle');

      presence = { presence: 'listening', cue: 'waveform', label: 'Listening', updatedAt: 'now' };
      await vi.advanceTimersByTimeAsync(120);
      expect(document.querySelector('.orb')?.getAttribute('data-presence')).toBe('listening');
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
