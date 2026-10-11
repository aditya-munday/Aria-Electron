import { describe, expect, it } from 'vitest';

import { ManualSpeaker } from './playback.js';
import { VoiceError } from './errors.js';

describe('ManualSpeaker', () => {
  it('resolves when playback advances', async () => {
    const speaker = new ManualSpeaker();
    const playing = speaker.play(new Int16Array(10), { sampleRate: 16000, channels: 1 });
    expect(speaker.isPlaying()).toBe(true);
    speaker.advance();
    await expect(playing).resolves.toBeUndefined();
    expect(speaker.playedBuffers()).toHaveLength(1);
  });

  it('rejects an interrupted playback promptly with a cancelled error', async () => {
    const speaker = new ManualSpeaker();
    const playing = speaker.play(new Int16Array(10), { sampleRate: 16000, channels: 1 });
    await speaker.stop();
    await expect(playing).rejects.toMatchObject({ kind: 'cancelled' });
    expect(speaker.isPlaying()).toBe(false);
  });

  it('replaces a previous playback rather than stacking it', async () => {
    const speaker = new ManualSpeaker();
    const first = speaker.play(new Int16Array(10), { sampleRate: 16000, channels: 1 });
    const second = speaker.play(new Int16Array(20), { sampleRate: 16000, channels: 1 });
    await expect(first).rejects.toBeInstanceOf(VoiceError);
    speaker.advance();
    await expect(second).resolves.toBeUndefined();
  });

  it('fails observably when the device is lost', async () => {
    const speaker = new ManualSpeaker();
    const playing = speaker.play(new Int16Array(10), { sampleRate: 16000, channels: 1 });
    speaker.fail();
    await expect(playing).rejects.toMatchObject({ kind: 'playback_failed' });
  });

  it('stop with nothing playing is a no-op', async () => {
    const speaker = new ManualSpeaker();
    await expect(speaker.stop()).resolves.toBeUndefined();
  });
});
