import { describe, expect, it } from 'vitest';

import { DEFAULT_WAKE_WORD, EngineWakeWordDetector, WakeWordController, type WakeWordEngine } from './wake-word.js';
import { FakeWakeWordDetector, manualClock } from './testing/voice-doubles.js';
import { silence } from './testing/fake-audio.js';

const FRAME = silence(320);

describe('EngineWakeWordDetector', () => {
  function engine(overrides: Partial<WakeWordEngine> = {}): WakeWordEngine {
    return {
      engineId: 'test-engine',
      modelId: 'model-v1',
      init: async () => undefined,
      process: () => undefined,
      release: async () => undefined,
      ...overrides,
    };
  }

  it('reports status and model through its lifecycle', async () => {
    const detector = new EngineWakeWordDetector(engine());
    expect(detector.status()).toBe('unavailable');
    expect(detector.model()).toBeUndefined();
    await detector.init();
    expect(detector.status()).toBe('ready');
    expect(detector.model()).toBe('model-v1');
    await detector.close();
    expect(detector.status()).toBe('unavailable');
  });

  it('ignores frames pushed before init', () => {
    let processed = 0;
    const detector = new EngineWakeWordDetector(
      engine({ process: () => { processed += 1; return undefined; } }),
    );
    detector.push(FRAME);
    expect(processed).toBe(0);
  });

  it('latches to failed and reports the reason when the model fails to load', async () => {
    const detector = new EngineWakeWordDetector(
      engine({ init: async () => { throw new Error('model file missing'); } }),
    );
    await expect(detector.init()).rejects.toThrow('model file missing');
    expect(detector.status()).toBe('failed');
    expect(detector.failure()).toBe('model file missing');
  });

  it('contains a processing fault and latches to failed rather than throwing', async () => {
    const detector = new EngineWakeWordDetector(
      engine({ process: () => { throw new Error('engine crash'); } }),
    );
    await detector.init();
    expect(detector.push(FRAME)).toBeUndefined();
    expect(detector.status()).toBe('failed');
    expect(detector.failure()).toBe('engine crash');
  });
});

describe('WakeWordController', () => {
  it('activates once for a sustained detection and applies the cooldown', async () => {
    const clock = manualClock();
    const detector = new FakeWakeWordDetector({
      id: 'fake',
      model: 'fake-model',
      repeatDetection: { phrase: 'hey aria', confidence: 0.9 },
    });
    const controller = new WakeWordController({
      detector,
      config: { ...DEFAULT_WAKE_WORD, enabled: true, cooldownMs: 1_500 },
    });
    await controller.init();
    const first = controller.push(FRAME, clock.now());
    expect(first?.phrase).toBe('hey aria');
    // A second detection within the cooldown is suppressed.
    clock.advance(500);
    expect(controller.push(FRAME, clock.now())).toBeUndefined();
    // After the cooldown it activates again.
    clock.advance(1_500);
    expect(controller.push(FRAME, clock.now())).toBeDefined();
  });

  it('ignores detections below the confidence floor', async () => {
    const clock = manualClock();
    const detector = new FakeWakeWordDetector({
      repeatDetection: { phrase: 'hey aria', confidence: 0.1 },
    });
    const controller = new WakeWordController({
      detector,
      config: { ...DEFAULT_WAKE_WORD, enabled: true, minConfidence: 0.5 },
    });
    await controller.init();
    expect(controller.push(FRAME, clock.now())).toBeUndefined();
  });

  it('does not run when disabled, and does not init the detector', async () => {
    const clock = manualClock();
    const detector = new FakeWakeWordDetector({
      repeatDetection: { phrase: 'hey aria', confidence: 0.9 },
    });
    const controller = new WakeWordController({
      detector,
      config: { ...DEFAULT_WAKE_WORD, enabled: false },
    });
    await controller.init();
    expect(detector.status()).toBe('unavailable');
    expect(controller.push(FRAME, clock.now())).toBeUndefined();
  });
});
