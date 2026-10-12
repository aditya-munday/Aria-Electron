import { execFileSync } from 'node:child_process';

import type { AudioFormat } from './audio-format.js';

/** One command-line audio tool Aria can drive, with the shape it needs. */
export interface AudioToolBackend {
  /** Whether a streaming recorder is available for push-to-talk and wake word. */
  readonly capture: boolean;
  /** Whether a player is available for spoken responses. */
  readonly playback: boolean;
  readonly captureCommand?: string;
  readonly playbackCommand?: string;
  /** The recorder's error stream, when it carries one Aria should read. */
  readonly captureStdErr: 'inherit' | 'ignore';
  readonly playbackStdErr: 'inherit' | 'ignore';
}

export const NO_AUDIO_TOOL_BACKEND: AudioToolBackend = {
  capture: false,
  playback: false,
  captureStdErr: 'ignore',
  playbackStdErr: 'ignore',
};

/** The capture tools Aria prefers, in order: a recorder that prints raw PCM. */
export const CAPTURE_TOOLS: readonly string[] = ['parec', 'arecord', 'pw-record'];
/** The playback tools Aria prefers, in order: a player that reads raw PCM. */
export const PLAYBACK_TOOLS: readonly string[] = ['pacat', 'aplay', 'pw-play'];

export type AudioToolProbe = (command: string) => boolean;

/** The recorder arguments for a tool, using its raw-PCM flags. */
export function captureArgs(
  command: string,
  format: AudioFormat,
  frameMs: number,
): readonly string[] {
  switch (command) {
    case 'arecord':
      return [
        '-q',
        '-t',
        'raw',
        '-f',
        'S16_LE',
        '-r',
        String(format.sampleRate),
        '-c',
        String(format.channels),
      ];
    case 'pw-record':
      return [
        '--rate',
        String(format.sampleRate),
        '--channels',
        String(format.channels),
        '--format',
        's16',
        '--raw',
      ];
    default:
      return [
        `--rate=${format.sampleRate}`,
        `--channels=${format.channels}`,
        '--format=s16le',
        `--latency-msec=${Math.max(1, Math.round(frameMs))}`,
        '--raw',
      ];
  }
}

/** The player arguments for a tool reading raw PCM from stdin. */
export function playbackArgs(command: string, format: AudioFormat): readonly string[] {
  switch (command) {
    case 'aplay':
      return [
        '-q',
        '-t',
        'raw',
        '-f',
        'S16_LE',
        '-r',
        String(format.sampleRate),
        '-c',
        String(format.channels),
        '-',
      ];
    case 'pw-play':
      return [
        '--rate',
        String(format.sampleRate),
        '--channels',
        String(format.channels),
        '--format',
        's16',
        '-',
      ];
    default:
      return [`--rate=${format.sampleRate}`, `--channels=${format.channels}`, `--format=s16le`];
  }
}

export interface ProbeOptions {
  readonly captureTools?: readonly string[];
  readonly playbackTools?: readonly string[];
  readonly probe?: AudioToolProbe;
}

function defaultProbe(command: string): boolean {
  try {
    execFileSync('which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Probe the host for a usable recorder and player, once at startup. */
export function probeAudioToolBackend(options: ProbeOptions = {}): AudioToolBackend {
  const probe = options.probe ?? defaultProbe;
  const captureTools = options.captureTools ?? CAPTURE_TOOLS;
  const playbackTools = options.playbackTools ?? PLAYBACK_TOOLS;
  const captureCommand = captureTools.find((command) => probe(command));
  const playbackCommand = playbackTools.find((command) => probe(command));
  return {
    capture: captureCommand !== undefined,
    playback: playbackCommand !== undefined,
    ...(captureCommand !== undefined ? { captureCommand } : {}),
    ...(playbackCommand !== undefined ? { playbackCommand } : {}),
    // arecord and aplay print their banner on stderr; forward it so a device
    // failure is visible in diagnostics rather than swallowed.
    captureStdErr: captureCommand === 'arecord' ? 'inherit' : 'ignore',
    playbackStdErr: playbackCommand === 'aplay' ? 'inherit' : 'ignore',
  };
}
