import { describe, expect, it } from 'vitest';

import { createVoxrtDetector } from './voxrt-detector.js';

/**
 * Guards the wake-word guarantee at the level that packaging can break: the
 * shipped `@voxrt/wake-word-browser` package and its `.vxrt` model must both be
 * present and loadable. A missing package or model is exactly what would make
 * the shipped `.deb` silently fail to hear "Hey Assistant", so the detector must
 * reach `ready` with the model loaded — not latch into `failed`.
 */
describe('shipped VoxRT detector', () => {
  it('loads the packaged engine and model to a ready state', async () => {
    const detector = createVoxrtDetector();
    await detector.init();
    expect(detector.status()).toBe('ready');
    expect(detector.model()).toContain('voxrt_wake_word.vxrt');
    expect(detector.failure()).toBeUndefined();
    await detector.close();
  });

  it('does not fire on silence', async () => {
    const detector = createVoxrtDetector();
    await detector.init();
    const silence = new Float64Array(320);
    for (let i = 0; i < 50; i += 1) {
      expect(detector.push(silence)).toBeUndefined();
    }
    await detector.close();
  });
});
