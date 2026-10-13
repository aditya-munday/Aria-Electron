import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WAKE_PHRASE_ENGINE,
  WakePhraseEngine,
  createWakePhraseEngine,
} from './wake-phrase-engine.js';
import { resample } from './formant-synth.js';
import { EngineWakeWordDetector, WakeWordController } from './wake-word.js';
import { frameBuffer, noise, silence, speakPhrase, tone } from './testing/fake-audio.js';

const SAMPLE_RATE = 16_000;
const FRAME = 320;

/**
 * A recording of a phrase: a quiet room, the utterance at a speaking rate, then
 * a quiet room again, with a little sensor noise throughout so the fixture is
 * not unrealistically clean.
 */
function recording(phrase: string, rate = 1, seed = 1, noiseLevel = 0.004): Float64Array[] {
  const speech = rate === 1 ? speakPhrase(phrase, SAMPLE_RATE, seed) : resample(speakPhrase(phrase, SAMPLE_RATE, seed), rate);
  const stream = new Float64Array(6400 + speech.length + 6400);
  stream.set(speech, 6400);
  const room = noise(stream.length, noiseLevel, seed + 977);
  for (let i = 0; i < stream.length; i += 1) stream[i] = (stream[i] as number) + (room[i] as number);
  return frameBuffer(stream, FRAME);
}

function engine(phrase: string): WakePhraseEngine {
  return new WakePhraseEngine({ ...DEFAULT_WAKE_PHRASE_ENGINE, phrase, sampleRate: SAMPLE_RATE });
}

describe('WakePhraseEngine detection', () => {
  it('detects the phrase it was built for', () => {
    const score = engine('hey aria').score(recording('hey aria'));
    expect(score.matched).toBe(true);
    expect(score.confidence).toBeGreaterThan(0);
    expect(score.confidence).toBeLessThanOrEqual(1);
  });

  it('detects the phrase across a range of speaking rates', () => {
    for (const rate of [0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.4]) {
      const score = engine('hey aria').score(recording('hey aria', rate));
      expect(score.matched, `rate ${rate}`).toBe(true);
    }
  });

  it('is robust to a little sensor noise', () => {
    for (const level of [0.001, 0.004, 0.01]) {
      const score = engine('hey aria').score(recording('hey aria', 1, 1, level));
      expect(score.matched, `noise ${level}`).toBe(true);
    }
  });
});

describe('WakePhraseEngine rejection', () => {
  it('rejects a different phrase with a similar rhythm', () => {
    expect(engine('hey aria').score(recording('hello there', 1, 5)).matched).toBe(false);
  });

  it('rejects several unrelated phrases', () => {
    for (const phrase of ['goodbye world', 'open settings', 'computer on', 'play music']) {
      expect(engine('hey aria').score(recording(phrase, 1, 3)).matched, phrase).toBe(false);
    }
  });

  it('does not false-accept a different phrase at another rate', () => {
    for (const rate of [0.7, 1, 1.25]) {
      expect(engine('hey aria').score(recording('goodbye world', rate, 4)).matched, `rate ${rate}`).toBe(false);
    }
  });

  it('rejects a steady tone and white noise', () => {
    expect(engine('hey aria').score(frameBuffer(tone(16_000, 0.5, 440, SAMPLE_RATE), FRAME)).matched).toBe(false);
    expect(engine('hey aria').score(frameBuffer(noise(16_000, 0.3, 7), FRAME)).matched).toBe(false);
  });

  it('reports no detection for silence', () => {
    const score = engine('hey aria').score(frameBuffer(silence(16_000), FRAME));
    expect(score.matched).toBe(false);
    expect(score.segments).toBe(0);
  });

  it('rejects a phrase shorter than the wake phrase', () => {
    expect(engine('hey aria').score(recording('hi', 1, 2)).matched).toBe(false);
  });

  it('refuses to initialise a phrase with no matchable content', async () => {
    await expect(engine('   ').init()).rejects.toThrow();
  });
});

describe('WakePhraseEngine streaming', () => {
  it('emits exactly one detection for one utterance', async () => {
    const detector = engine('hey aria');
    await detector.init();
    let detections = 0;
    let last: { phrase: string; confidence: number } | undefined;
    for (const frame of recording('hey aria')) {
      const detection = detector.process(frame);
      if (detection !== undefined) {
        detections += 1;
        last = detection;
      }
    }
    expect(detections).toBe(1);
    expect(last?.phrase).toBe('hey aria');
  });

  it('emits nothing for a stream of noise', async () => {
    const detector = engine('hey aria');
    await detector.init();
    let detections = 0;
    for (const frame of frameBuffer(noise(32_000, 0.3, 9), FRAME)) {
      if (detector.process(frame) !== undefined) detections += 1;
    }
    expect(detections).toBe(0);
  });

  it('initialises and releases cleanly', async () => {
    const detector = engine('hey aria');
    await detector.init();
    await detector.release();
  });
});

describe('WakePhraseEngine integration', () => {
  it('activates a session once through the controller', async () => {
    const detector = new EngineWakeWordDetector(engine('hey aria'));
    const controller = new WakeWordController({
      detector,
      config: { enabled: true, phrase: 'hey aria', minConfidence: 0.3, cooldownMs: 1_500 },
    });
    await controller.init();
    expect(controller.status()).toBe('ready');

    let activations = 0;
    recording('hey aria').forEach((frame, index) => {
      if (controller.push(frame, index * 20) !== undefined) activations += 1;
    });
    expect(activations).toBe(1);
  });

  it('does nothing while disabled', async () => {
    const detector = new EngineWakeWordDetector(engine('hey aria'));
    const controller = new WakeWordController({
      detector,
      config: { enabled: false, phrase: 'hey aria', minConfidence: 0.3, cooldownMs: 0 },
    });
    await controller.init();
    let activations = 0;
    recording('hey aria').forEach((frame, index) => {
      if (controller.push(frame, index * 20) !== undefined) activations += 1;
    });
    expect(activations).toBe(0);
  });
});

describe('createWakePhraseEngine', () => {
  it('honours the phrase it is given', () => {
    const detector = createWakePhraseEngine('hey aria', SAMPLE_RATE);
    expect(detector.modelId).toBe('phrase:hey aria');
  });
});
