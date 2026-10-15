// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A minimal Web Audio stand-in that records the tones a cue schedules. */
function fakeAudio() {
  const started: number[] = [];
  class Osc {
    type = 'sine';
    frequency = {
      setValueAtTime: (value: number) => started.push(value),
      exponentialRampToValueAtTime: () => undefined,
    };
    connect() {
      return this;
    }
    start() {
      return undefined;
    }
    stop() {
      return undefined;
    }
  }
  class Gain {
    gain = { setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined };
    connect() {
      return this;
    }
  }
  class Ctx {
    state = 'running';
    currentTime = 0;
    destination = {};
    createOscillator() {
      return new Osc();
    }
    createGain() {
      return new Gain();
    }
    resume() {
      return Promise.resolve();
    }
    suspend() {
      return Promise.resolve();
    }
  }
  return { Ctx, started };
}

async function load() {
  vi.resetModules();
  return import('./sfx.js');
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  delete (globalThis as { AudioContext?: unknown }).AudioContext;
});

describe('sound layer', () => {
  it('is inert when the host has no AudioContext', async () => {
    const sfx = await load();
    expect(() => sfx.playCue('send')).not.toThrow();
  });

  it('schedules a tone for a cue when a context exists', async () => {
    const { Ctx, started } = fakeAudio();
    (globalThis as { AudioContext?: unknown }).AudioContext = Ctx;
    const sfx = await load();
    sfx.playCue('notify');
    expect(started).toEqual([660, 990]);
  });

  it('stays silent while muted, and remembers the choice', async () => {
    const { Ctx, started } = fakeAudio();
    (globalThis as { AudioContext?: unknown }).AudioContext = Ctx;
    const sfx = await load();
    sfx.setMuted(true);
    sfx.playCue('send');
    expect(started).toEqual([]);
    expect(sfx.isMuted()).toBe(true);
    sfx.setMuted(false);
    sfx.playCue('send');
    expect(started.length).toBeGreaterThan(0);
  });

  it('routes a document cue event through the layer', async () => {
    const { Ctx, started } = fakeAudio();
    (globalThis as { AudioContext?: unknown }).AudioContext = Ctx;
    const sfx = await load();
    const detach = sfx.attachCues(document);
    sfx.emitCue(document, 'error');
    expect(started).toEqual([300, 240]);
    detach();
  });

  it('does not stack the same cue inside the throttle window', async () => {
    const { Ctx, started } = fakeAudio();
    (globalThis as { AudioContext?: unknown }).AudioContext = Ctx;
    const sfx = await load();
    sfx.playCue('toggle');
    sfx.playCue('toggle');
    expect(started).toEqual([620]);
  });
});
