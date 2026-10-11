import { describe, expect, it } from 'vitest';

import { StopController, type LocalHaltReport } from './stop-controller.js';

function deps(overrides: Partial<{ halt: () => LocalHaltReport; interrupt: () => void }> = {}): {
  controller: StopController;
  halts: number;
  interrupts: number;
} {
  const counters = { halts: 0, interrupts: 0 };
  const controller = new StopController({
    haltLocal: () => {
      counters.halts += 1;
      return overrides.halt?.() ?? { captureHalted: true, playbackHalted: true };
    },
    interruptLocal: () => {
      counters.interrupts += 1;
      overrides.interrupt?.();
    },
    now: () => '2026-01-01T00:00:00.000Z',
  });
  return { controller, halts: counters.halts, interrupts: counters.interrupts };
}

describe('StopController', () => {
  it('engages locally and synchronously without any remote dependency', () => {
    const { controller } = deps();
    const outcome = controller.engage();
    expect(outcome.engaged).toBe(true);
    expect(outcome.localHalt).toEqual({ captureHalted: true, playbackHalted: true });
    expect(controller.isEngaged()).toBe(true);
    expect(outcome.engagedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('engages even when the local halt reports nothing halted', () => {
    const { controller } = deps({ halt: () => ({ captureHalted: false, playbackHalted: false }) });
    const outcome = controller.engage();
    expect(outcome.engaged).toBe(true);
    expect(outcome.localHalt.captureHalted).toBe(false);
  });

  it('interrupting speech is distinct from stopping playback and from cancelling', () => {
    const counters = { halts: 0, interrupts: 0 };
    const controller = new StopController({
      haltLocal: () => {
        counters.halts += 1;
        return { captureHalted: true, playbackHalted: true };
      },
      interruptLocal: () => {
        counters.interrupts += 1;
      },
    });
    const interrupt = controller.interruptSpeech();
    const stop = controller.stopPlayback();
    expect(interrupt.interrupted).toBe(true);
    expect(stop.stopped).toBe(true);
    expect(counters.interrupts).toBe(2);
    expect(controller.isEngaged()).toBe(false);
    expect(counters.halts).toBe(0);
  });

  it('can be released after engaging', () => {
    const { controller } = deps();
    controller.engage();
    controller.release();
    expect(controller.isEngaged()).toBe(false);
  });
});
