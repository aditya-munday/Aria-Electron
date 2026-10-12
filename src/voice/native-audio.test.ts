import { describe, expect, it } from 'vitest';

import { NO_AUDIO_TOOL_BACKEND, type AudioToolBackend } from './audio-tool.js';
import { createNativeAudio } from './native-audio.js';
import { VoiceError } from './errors.js';

const captureBackend: AudioToolBackend = {
  capture: true,
  playback: true,
  captureCommand: 'parec',
  playbackCommand: 'pacat',
  captureStdErr: 'ignore',
  playbackStdErr: 'ignore',
};

describe('NativeMicrophone', () => {
  it('denies permission and offers no devices when no recorder exists', async () => {
    const { microphone } = createNativeAudio({
      frameMs: 20,
      sampleRate: 16_000,
      backend: NO_AUDIO_TOOL_BACKEND,
    });
    expect(await microphone.permission()).toBe('denied');
    expect(await microphone.listDevices()).toEqual([]);
    await expect(
      microphone.open({ format: { sampleRate: 16_000, channels: 1 } }),
    ).rejects.toThrow();
  });

  it('grants permission and a default device when a recorder exists', async () => {
    const { microphone } = createNativeAudio({
      frameMs: 20,
      sampleRate: 16_000,
      backend: captureBackend,
    });
    expect(await microphone.permission()).toBe('granted');
    const devices = await microphone.listDevices();
    expect(devices[0]?.id).toBe('default');
    expect(devices[0]?.isDefault).toBe(true);
    expect(await microphone.captureCapableDevices?.()).toHaveLength(1);
  });

  it('opens a streaming capture bound to the recorder command', async () => {
    const { microphone } = createNativeAudio({
      frameMs: 20,
      sampleRate: 16_000,
      backend: captureBackend,
    });
    const handle = await microphone.open({ format: { sampleRate: 16_000, channels: 1 } });
    expect(handle.format).toEqual({ sampleRate: 16_000, channels: 1 });
    await handle.stop();
  });
});

describe('NativeSpeaker', () => {
  it('is a no-op when the host has no player, never an error', async () => {
    const { speaker } = createNativeAudio({
      frameMs: 20,
      sampleRate: 16_000,
      backend: NO_AUDIO_TOOL_BACKEND,
    });
    await expect(
      speaker.play(new Int16Array([1, 2, 3]), { sampleRate: 16_000, channels: 1 }),
    ).resolves.toBeUndefined();
  });

  it('never throws a raw error out of a play attempt', async () => {
    const { speaker } = createNativeAudio({
      frameMs: 20,
      sampleRate: 16_000,
      backend: captureBackend,
      spawn: () => {
        throw new VoiceError('playback_failed', 'no player');
      },
    });
    await expect(
      speaker.play(new Int16Array([1]), { sampleRate: 16_000, channels: 1 }),
    ).rejects.toMatchObject({ kind: 'playback_failed' });
  });
});
