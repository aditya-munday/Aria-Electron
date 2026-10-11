import { describe, expect, it } from 'vitest';

import { DEFAULT_PUSH_TO_TALK, createPushToTalk } from './push-to-talk.js';
import { VoiceError } from './errors.js';
import { manualClock } from './testing/voice-doubles.js';

describe('PushToTalkController', () => {
  it('begins capture immediately on press and never consults a wake word', () => {
    const clock = manualClock();
    const ptt = createPushToTalk({ config: DEFAULT_PUSH_TO_TALK, now: clock.now });
    const intents = ptt.press();
    expect(intents).toEqual([{ kind: 'begin' }]);
    expect(ptt.isCapturing()).toBe(true);
  });

  it('hold mode finalizes on release', () => {
    const clock = manualClock();
    const ptt = createPushToTalk({ config: DEFAULT_PUSH_TO_TALK, now: clock.now });
    ptt.press();
    clock.advance(500);
    expect(ptt.release()).toEqual([{ kind: 'finalize', reason: 'released' }]);
    expect(ptt.isCapturing()).toBe(false);
  });

  it('cancels an accidental short press instead of submitting', () => {
    const clock = manualClock();
    const ptt = createPushToTalk({ config: DEFAULT_PUSH_TO_TALK, now: clock.now });
    ptt.press();
    clock.advance(50); // below minPressMs
    expect(ptt.release()).toEqual([{ kind: 'cancel', reason: 'too_short' }]);
  });

  it('toggle mode starts on press and finalizes on the next press; release is ignored', () => {
    const clock = manualClock();
    const ptt = createPushToTalk({
      config: { ...DEFAULT_PUSH_TO_TALK, mode: 'toggle' },
      now: clock.now,
    });
    expect(ptt.press()).toEqual([{ kind: 'begin' }]);
    // Releasing a toggle control does not finalize.
    expect(ptt.release()).toEqual([]);
    expect(ptt.isCapturing()).toBe(true);
    clock.advance(400);
    expect(ptt.press()).toEqual([{ kind: 'finalize', reason: 'released' }]);
    expect(ptt.isCapturing()).toBe(false);
  });

  it('finalizes automatically at the maximum utterance duration', () => {
    const clock = manualClock();
    const ptt = createPushToTalk({
      config: { ...DEFAULT_PUSH_TO_TALK, maxUtteranceMs: 1_000 },
      now: clock.now,
    });
    ptt.press();
    clock.advance(1_000);
    expect(ptt.pollMaxDuration()).toEqual([{ kind: 'finalize', reason: 'max_duration' }]);
    expect(ptt.isCapturing()).toBe(false);
  });

  it('ignores a duplicate press while already held', () => {
    const clock = manualClock();
    const ptt = createPushToTalk({ config: DEFAULT_PUSH_TO_TALK, now: clock.now });
    ptt.press();
    expect(ptt.press()).toEqual([]);
  });

  it('does nothing when disabled', () => {
    const clock = manualClock();
    const ptt = createPushToTalk({
      config: { ...DEFAULT_PUSH_TO_TALK, enabled: false },
      now: clock.now,
    });
    expect(ptt.press()).toEqual([]);
    expect(ptt.release()).toEqual([]);
  });

  it('validates its configuration', () => {
    const clock = manualClock();
    expect(() =>
      createPushToTalk({
        config: { ...DEFAULT_PUSH_TO_TALK, maxUtteranceMs: 100, minPressMs: 200 },
        now: clock.now,
      }),
    ).toThrow(VoiceError);
  });
});
