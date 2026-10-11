import { describe, expect, it } from 'vitest';

import { IDLE_CAPTURE, MuteController, type CaptureMode } from './mute.js';

const PUSH_TO_TALK: CaptureMode = { kind: 'push_to_talk', mode: 'hold' };
const WAKE_WORD: CaptureMode = { kind: 'wake_word', phrase: 'hey aria' };

describe('MuteController', () => {
  it('refuses every capture activation while muted', () => {
    const mute = new MuteController({ muted: true });
    expect(mute.mayCapture(PUSH_TO_TALK)).toBe(false);
    expect(mute.mayCapture(WAKE_WORD)).toBe(false);
    expect(mute.isMuted()).toBe(true);
  });

  it('restores the exact prior mode on unmute', () => {
    const mute = new MuteController({ muted: false });
    expect(mute.mayCapture(WAKE_WORD)).toBe(true);
    expect(mute.captureMode()).toEqual(WAKE_WORD);

    mute.mute();
    expect(mute.mayCapture(PUSH_TO_TALK)).toBe(false);
    // A refused activation does not overwrite the remembered mode.
    expect(mute.captureMode()).toEqual(WAKE_WORD);

    mute.unmute();
    expect(mute.mayCapture(WAKE_WORD)).toBe(true);
    expect(mute.captureMode()).toEqual(WAKE_WORD);
  });

  it('records the mode the user actually activated', () => {
    const mute = new MuteController({ muted: false });
    expect(mute.captureMode()).toEqual(IDLE_CAPTURE);
    expect(mute.mayCapture(PUSH_TO_TALK)).toBe(true);
    expect(mute.captureMode()).toEqual(PUSH_TO_TALK);
  });

  it('survives a window reopen by reconstructing from the persisted flag', () => {
    const first = new MuteController({ muted: true });
    first.rememberMode(WAKE_WORD);
    const persisted = first.view();
    expect(persisted.muted).toBe(true);

    const reopened = new MuteController({ muted: persisted.muted, mode: persisted.mode });
    expect(reopened.isMuted()).toBe(true);
    expect(reopened.captureMode()).toEqual(WAKE_WORD);
    reopened.unmute();
    expect(reopened.mayCapture(WAKE_WORD)).toBe(true);
  });
});
