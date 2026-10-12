import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createOrbDismissal, DEFAULT_ORB_DISMISSAL } from './dismiss.js';
import type { VoiceEvent } from '../voice/events.js';

class FakeVoice {
  private readonly listeners = new Set<(event: VoiceEvent) => void>();
  on(listener: (event: VoiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: VoiceEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

let seq = 0;
function event(type: VoiceEvent['type'], extra: Record<string, unknown> = {}): VoiceEvent {
  seq += 1;
  return { type, sessionId: 's1', at: seq, ...extra } as VoiceEvent;
}

function build(options: { visible?: boolean } = {}) {
  const voice = new FakeVoice();
  let visible = options.visible ?? true;
  let hidden = 0;
  const dismissal = createOrbDismissal({
    voice,
    hide: () => {
      hidden += 1;
      visible = false;
    },
    isVisible: () => visible,
  });
  return { voice, dismissal, hidden: () => hidden, show: () => { visible = true; } };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('orb dismissal', () => {
  it('dismisses a few seconds after spoken output finishes', () => {
    const { voice, dismissal, hidden } = build();
    dismissal.start();
    voice.emit(event('playback.finished'));
    vi.advanceTimersByTime(DEFAULT_ORB_DISMISSAL.afterPlaybackMs - 1);
    expect(hidden()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(hidden()).toBe(1);
  });

  it('does not dismiss while a turn is still running', () => {
    const { voice, dismissal, hidden } = build();
    dismissal.start();
    voice.emit(event('session.state', { state: 'thinking' }));
    vi.advanceTimersByTime(60_000);
    expect(hidden()).toBe(0);
  });

  it('cancels a pending dismissal when a new turn starts', () => {
    const { voice, dismissal, hidden } = build();
    dismissal.start();
    voice.emit(event('playback.finished'));
    vi.advanceTimersByTime(1000);
    voice.emit(event('session.started', { source: 'push_to_talk' }));
    vi.advanceTimersByTime(60_000);
    expect(hidden()).toBe(0);
  });

  it('keeps the soonest pending dismissal when several quiet signals arrive', () => {
    const { voice, dismissal, hidden } = build();
    dismissal.start();
    voice.emit(event('response', { text: 'done' }));
    voice.emit(event('playback.finished'));
    vi.advanceTimersByTime(DEFAULT_ORB_DISMISSAL.afterPlaybackMs - 1);
    expect(hidden()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(hidden()).toBe(1);
  });

  it('dismisses after a failed turn', () => {
    const { voice, dismissal, hidden } = build();
    dismissal.start();
    voice.emit(event('session.failed', { error: 'boom', kind: 'speech_failed' }));
    vi.advanceTimersByTime(DEFAULT_ORB_DISMISSAL.afterResponseMs);
    expect(hidden()).toBe(1);
  });

  it('dismisses after a cancelled turn', () => {
    const { voice, dismissal, hidden } = build();
    dismissal.start();
    voice.emit(event('session.cancelled', { reason: 'interrupted' }));
    vi.advanceTimersByTime(DEFAULT_ORB_DISMISSAL.afterCancelledMs);
    expect(hidden()).toBe(1);
  });

  it('dismisses an empty final transcript that never became a response', () => {
    const { voice, dismissal, hidden } = build();
    dismissal.start();
    voice.emit(event('transcript', { text: '   ', final: true }));
    vi.advanceTimersByTime(DEFAULT_ORB_DISMISSAL.afterCancelledMs);
    expect(hidden()).toBe(1);
  });

  it('leaves a visible orb alone until a dismissal is scheduled', () => {
    const { dismissal, hidden } = build();
    dismissal.start();
    vi.advanceTimersByTime(60_000);
    expect(hidden()).toBe(0);
  });

  it('does not call hide again when the orb is already gone', () => {
    const { voice, dismissal, hidden } = build();
    dismissal.start();
    voice.emit(event('playback.finished'));
    vi.advanceTimersByTime(DEFAULT_ORB_DISMISSAL.afterPlaybackMs);
    voice.emit(event('session.state', { state: 'idle' }));
    vi.advanceTimersByTime(60_000);
    expect(hidden()).toBe(1);
  });

  it('cancels a pending dismissal when stopped', () => {
    const { voice, dismissal, hidden } = build();
    dismissal.start();
    voice.emit(event('playback.finished'));
    dismissal.stop();
    vi.advanceTimersByTime(60_000);
    expect(hidden()).toBe(0);
  });

  it('ignores events after stop', () => {
    const { voice, dismissal, hidden } = build();
    dismissal.start();
    dismissal.stop();
    voice.emit(event('playback.finished'));
    vi.advanceTimersByTime(60_000);
    expect(hidden()).toBe(0);
  });
});
