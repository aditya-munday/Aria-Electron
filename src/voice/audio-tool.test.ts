import { describe, expect, it } from 'vitest';

import {
  CAPTURE_TOOLS,
  PLAYBACK_TOOLS,
  NO_AUDIO_TOOL_BACKEND,
  captureArgs,
  playbackArgs,
  probeAudioToolBackend,
} from './audio-tool.js';

const format = { sampleRate: 16_000, channels: 1 };

describe('probeAudioToolBackend', () => {
  it('selects the first capture and playback tool the host provides', () => {
    const backend = probeAudioToolBackend({
      probe: (command) => command === 'arecord' || command === 'aplay',
    });
    expect(backend.capture).toBe(true);
    expect(backend.captureCommand).toBe('arecord');
    expect(backend.playback).toBe(true);
    expect(backend.playbackCommand).toBe('aplay');
  });

  it('prefers pulse tools when both pulse and alsa are present', () => {
    const backend = probeAudioToolBackend({ probe: () => true });
    expect(backend.captureCommand).toBe('parec');
    expect(backend.playbackCommand).toBe('pacat');
  });

  it('reports nothing when the host has no audio tools', () => {
    const backend = probeAudioToolBackend({ probe: () => false });
    expect(backend.capture).toBe(false);
    expect(backend.playback).toBe(false);
    expect(backend.captureCommand).toBeUndefined();
    expect(backend.playbackCommand).toBeUndefined();
    expect(NO_AUDIO_TOOL_BACKEND.capture).toBe(false);
  });

  it('exposes ordered tool preferences', () => {
    expect(CAPTURE_TOOLS[0]).toBe('parec');
    expect(PLAYBACK_TOOLS[0]).toBe('pacat');
  });
});

describe('captureArgs', () => {
  it('uses the ALSA raw-PCM flags for arecord', () => {
    expect(captureArgs('arecord', format, 20)).toEqual([
      '-q',
      '-t',
      'raw',
      '-f',
      'S16_LE',
      '-r',
      '16000',
      '-c',
      '1',
    ]);
  });

  it('uses the PulseAudio raw flags for parec, including the frame latency', () => {
    expect(captureArgs('parec', format, 20)).toContain('--format=s16le');
    expect(captureArgs('parec', format, 20)).toContain('--latency-msec=20');
  });

  it('uses the PipeWire raw flags for pw-record', () => {
    expect(captureArgs('pw-record', format, 20)).toContain('--raw');
    expect(captureArgs('pw-record', format, 20)).toContain('s16');
  });
});

describe('playbackArgs', () => {
  it('reads raw PCM from stdin for each player', () => {
    expect(playbackArgs('aplay', format)).toContain('-');
    expect(playbackArgs('pw-play', format)).toContain('-');
    expect(playbackArgs('pacat', format)).toContain('--format=s16le');
  });
});
