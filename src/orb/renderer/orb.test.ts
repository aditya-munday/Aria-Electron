// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { renderOrb, wirePointerInteractivity, bootstrapOrb, type OrbBridge } from './orb.js';
import type { OrbState } from '../state.js';
import { ORB_WINDOW_SIZE } from '../window-options.js';

// jsdom has no canvas backend; returning null stands in for it without the
// not-implemented warning jsdom raises when getContext is called.
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
});

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

  it('draws a single radial sphere with a glow, no frame elements', () => {
    const root = render(state());
    expect(root.querySelectorAll('.sphere')).toHaveLength(1);
    expect(root.querySelectorAll('.radial-surface')).toHaveLength(1);
    expect(root.querySelectorAll('.glow')).toHaveLength(1);
    expect(root.querySelector('.panel')).toBeNull();
    expect(root.querySelector('.frame')).toBeNull();
  });

  it('paints the radial surface into a canvas and hides it from assistive tech', () => {
    const root = render(state());
    const canvas = root.querySelector('canvas.radial-surface') as HTMLCanvasElement;
    expect(canvas).not.toBeNull();
    expect(canvas.getAttribute('aria-hidden')).toBe('true');
  });

  it('falls back to the CSS radial face when no WebGL context is available', () => {
    const root = render(state());
    expect(root.querySelector('.sphere')?.classList.contains('radial-fallback')).toBe(true);
  });

  it('maps each presence onto a radial state the shader can animate', () => {
    const root = render(state({ presence: 'speaking', cue: 'bars', label: 'Speaking' }));
    const orb = root.querySelector('.orb') as HTMLElement;
    expect(orb.getAttribute('data-orb-ui-state')).toBe('speaking');
    expect(orb.getAttribute('data-orb-ui-theme')).toBe('radial-ultra');
  });

  it('tints the glass with a cue-specific accent hue', () => {
    const root = render(state({ presence: 'speaking', cue: 'bars', label: 'Speaking' }));
    const orb = root.querySelector('.orb') as HTMLElement;
    expect(orb.style.getPropertyValue('--cue-hue')).toBe('152');
  });

  it('renders the listening waveform cue', () => {
    const root = render(state({ presence: 'listening', cue: 'waveform', label: 'Listening' }));
    const orb = root.querySelector('.orb') as HTMLElement;
    expect(orb.getAttribute('data-cue')).toBe('waveform');
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
    const orb = root.querySelector('.orb') as HTMLElement;
    expect(orb.getAttribute('data-cue')).toBe('alert');
    expect(root.querySelector('[data-testid="orb-detail"]')?.textContent).toBe('Microphone access was denied.');
  });

  it('renders the muted slash cue', () => {
    const root = render(state({ presence: 'muted', cue: 'slash', label: 'Muted' }));
    const orb = root.querySelector('.orb') as HTMLElement;
    expect(orb.getAttribute('data-cue')).toBe('slash');
  });

  it('exposes an accessible label combining the presence and detail', () => {
    const root = render(state({ presence: 'thinking', cue: 'pulse', label: 'Thinking' }));
    const orb = root.querySelector('.orb') as HTMLElement;
    expect(orb.getAttribute('role')).toBe('button');
    expect(orb.getAttribute('tabindex')).toBe('0');
    expect(orb.getAttribute('aria-label')).toContain('Thinking');
  });

  it('shows an action hint when the presence carries no detail', () => {
    const root = render(state({ presence: 'idle', cue: 'dot', label: 'Idle' }));
    expect(root.querySelector('[data-testid="orb-detail"]')?.textContent).toBe('Tap to open chat');
  });

  it('renders the status ring, core, sheen and orbiting motes', () => {
    const root = render(state());
    expect(root.querySelectorAll('.ring')).toHaveLength(1);
    expect(root.querySelectorAll('.core')).toHaveLength(1);
    expect(root.querySelectorAll('.sheen')).toHaveLength(1);
    expect(root.querySelectorAll('.orbit .mote')).toHaveLength(3);
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

  it('opens the chat when the circle is clicked, but not when the glow is', () => {
    document.body.innerHTML = '<main id="orb"></main>';
    let opened = 0;
    const b: OrbBridge = {
      orbState: async () => state(),
      orbSetInteractive: async () => undefined,
      openChat: async () => {
        opened += 1;
      },
    };
    wirePointerInteractivity(document, b);
    const center = ORB_WINDOW_SIZE / 2;
    document.dispatchEvent(new MouseEvent('click', { clientX: 4, clientY: 4 }));
    expect(opened).toBe(0);
    document.dispatchEvent(new MouseEvent('click', { clientX: center, clientY: center }));
    expect(opened).toBe(1);
  });

  it('opens the chat on Enter for a keyboard user', () => {
    document.body.innerHTML = '<main id="orb"></main>';
    let opened = 0;
    const b: OrbBridge = {
      orbState: async () => state(),
      orbSetInteractive: async () => undefined,
      openChat: async () => {
        opened += 1;
      },
    };
    wirePointerInteractivity(document, b);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(opened).toBe(1);
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

  it('does not rebuild the Orb while only the timestamp advances', async () => {
    vi.useFakeTimers();
    try {
      document.body.innerHTML = '<main id="orb"></main>';
      let tick = 0;
      const b: OrbBridge = {
        orbState: async () => ({
          generatedAt: `t${tick}`,
          presence: { presence: 'idle', cue: 'dot', label: 'Idle', updatedAt: `t${tick++}` },
        }),
        orbSetInteractive: async () => undefined,
      };
      const stop = bootstrapOrb(document, b, 100);
      await vi.advanceTimersByTimeAsync(0);
      const first = document.querySelector('.orb');
      expect(first).not.toBeNull();
      await vi.advanceTimersByTimeAsync(500);
      // Five more polls with a fresh `updatedAt` each: the node must survive.
      expect(document.querySelector('.orb')).toBe(first);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reuses the sphere and its single WebGL context across presence changes', () => {
    document.body.innerHTML = '<main id="orb"></main>';
    const original = HTMLCanvasElement.prototype.getContext;
    const contexts: number[] = [];
    HTMLCanvasElement.prototype.getContext = (() => {
      contexts.push(1);
      return null;
    }) as typeof HTMLCanvasElement.prototype.getContext;
    try {
      renderOrb(document, state({ presence: 'idle', cue: 'dot', label: 'Idle' }));
      const sphere = document.querySelector('.sphere');
      renderOrb(document, state({ presence: 'speaking', cue: 'bars', label: 'Speaking' }));
      renderOrb(document, state({ presence: 'error', cue: 'alert', label: 'Error' }));

      expect(document.querySelectorAll('.sphere')).toHaveLength(1);
      expect(document.querySelector('.sphere')).toBe(sphere);
      expect(document.querySelector('.orb')?.getAttribute('data-presence')).toBe('error');
      expect(contexts.length).toBe(1);
    } finally {
      HTMLCanvasElement.prototype.getContext = original;
    }
  });

  it('paints nothing while the presence is hidden', () => {
    document.body.innerHTML = '<main id="orb"></main>';
    renderOrb(document, state({ presence: 'hidden', cue: 'none', label: 'Hidden' }));
    expect(document.querySelector('.orb')).toBeNull();
    expect(document.querySelectorAll('canvas')).toHaveLength(0);
  });
});
