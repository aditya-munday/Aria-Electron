import { describe, expect, it } from 'vitest';

import { WakeWordListener } from './wake-listener.js';
import { DEFAULT_WAKE_WORD, WakeWordController } from './wake-word.js';
import { FakeMicrophone, tone } from './testing/fake-audio.js';
import { FakeWakeWordDetector, manualClock } from './testing/voice-doubles.js';
import type { VoiceError } from './errors.js';

function build(options: {
  microphone?: FakeMicrophone;
  detector?: FakeWakeWordDetector;
  onActivation?: (a: { phrase: string; confidence: number }) => void;
}) {
  const clock = manualClock();
  const microphone = options.microphone ?? new FakeMicrophone();
  const detector = options.detector ?? new FakeWakeWordDetector({
    repeatDetection: { phrase: 'hey aria', confidence: 0.9 },
  });
  const controller = new WakeWordController({
    detector,
    config: { ...DEFAULT_WAKE_WORD, enabled: true },
  });
  const errors: VoiceError[] = [];
  const activations: { phrase: string; confidence: number }[] = [];
  const listener = new WakeWordListener({
    microphone,
    controller,
    sampleRate: 16_000,
    frameMs: 20,
    now: clock.now,
    onActivation: (a) => {
      activations.push(a);
      options.onActivation?.(a);
    },
    onError: (e) => errors.push(e),
  });
  return { listener, microphone, detector, controller, errors, activations };
}

describe('WakeWordListener', () => {
  it('does not start without microphone permission', async () => {
    const built = build({ microphone: new FakeMicrophone({ permission: 'denied' }) });
    await built.listener.start();
    expect(built.listener.status()).toBe('failed');
    expect(built.errors[0]?.kind).toBe('permission_denied');
  });

  it('activates once and stops listening so the session owns the microphone', async () => {
    const built = build({});
    await built.controller.init();
    await built.listener.start();
    expect(built.listener.isListening()).toBe(true);
    built.microphone.lastHandle()?.emit(tone(320, 0.5));
    expect(built.activations).toHaveLength(1);
    expect(built.listener.isListening()).toBe(false);
  });

  it('never submits audio anywhere: it only feeds the detector', async () => {
    const built = build({});
    await built.controller.init();
    await built.listener.start();
    built.microphone.lastHandle()?.emit(tone(320, 0.5));
    // The only observable effect is a detection; there is no network seam here.
    expect(built.detector.pushCount()).toBe(1);
  });

  it('reports a device loss as a recoverable failed state', async () => {
    const built = build({});
    await built.listener.start();
    built.microphone.lastHandle()?.lose();
    expect(built.listener.status()).toBe('failed');
    expect(built.errors[0]?.kind).toBe('device_unavailable');
    built.listener.reset();
    expect(built.listener.status()).toBe('stopped');
  });

  it('stop is idempotent and releases capture', async () => {
    const built = build({});
    await built.listener.start();
    await built.listener.stop();
    await built.listener.stop();
    expect(built.listener.isListening()).toBe(false);
    expect(built.microphone.lastHandle()?.isStarted).toBe(false);
  });
});
