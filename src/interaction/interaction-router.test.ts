import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INTERACTION_ENVIRONMENT,
  isRoutedControl,
  isRoutedSession,
  routeActivation,
  type InteractionEnvironment,
  type RoutedSession,
} from './interaction-router.js';

/** An environment where voice activation is fully available. */
const VOICE_READY: InteractionEnvironment = {
  wakeWordEnabled: true,
  microphonePermission: 'granted',
  voiceSessionActive: false,
};

function session(source: Parameters<typeof routeActivation>[0], env = VOICE_READY): RoutedSession {
  const result = routeActivation(source, env);
  if (result.kind !== 'routed') throw new Error(`expected a routed result, got ${result.kind}`);
  if (!isRoutedSession(result.routed)) throw new Error('expected a session routing');
  return result.routed;
}

describe('interaction routing: surface and input identity', () => {
  it('routes a normal app launch to the Control Center with no input path at all', () => {
    const routed = session({ kind: 'app_launch' });
    expect(routed.kind).toBe('launch');
    expect(routed.surface).toBe('control_center');
    expect(routed.input).toBe('none');
    expect(routed.inputPath).toBeUndefined();
    // No mic, no STT, no orchestration, no TTS.
    expect(routed.capture).toBe(false);
    expect(routed.transcribe).toBe(false);
    expect(routed.orchestrates).toBe(false);
  });

  it('routes typed text to the chat window straight to orchestration, bypassing STT', () => {
    const routed = session({ kind: 'typed_text', text: '  summarise the build  ' });
    expect(routed.surface).toBe('chat');
    expect(routed.input).toBe('text');
    expect(routed.inputPath).toBeUndefined();
    expect(routed.capture).toBe(false);
    expect(routed.transcribe).toBe(false);
    expect(routed.orchestrates).toBe(true);
    expect(routed.text).toBe('summarise the build');
  });

  it('does not orchestrate empty typed text', () => {
    const routed = session({ kind: 'typed_text', text: '   ' });
    expect(routed.input).toBe('text');
    expect(routed.orchestrates).toBe(false);
    expect(routed.text).toBe('');
  });

  it('routes wake-word activation to the Orb with a voice input path', () => {
    const routed = session({ kind: 'wake_word' });
    expect(routed.surface).toBe('orb');
    expect(routed.input).toBe('voice');
    expect(routed.inputPath).toBe('wake_word');
    expect(routed.capture).toBe(true);
    expect(routed.transcribe).toBe(true);
    expect(routed.orchestrates).toBe(true);
  });

  it('carries source and input explicitly on every routed session', () => {
    const voice = session({ kind: 'wake_word' });
    const text = session({ kind: 'typed_text', text: 'hello' });
    // The exact activation is named; downstream never infers it from a flag.
    expect(voice.source).toBe('wake_word');
    expect(text.source).toBe('typed_text');
    // Voice and text are distinguishable by `input` alone.
    expect(voice.input).not.toBe(text.input);
    expect(voice.text).toBeUndefined();
    expect(text.inputPath).toBeUndefined();
  });

  it('keeps a task cancellation from being a routed session', () => {
    const result = routeActivation({ kind: 'cancel_task', taskId: 't1' }, VOICE_READY);
    expect(result.kind).toBe('routed');
    if (result.kind !== 'routed') return;
    expect(isRoutedSession(result.routed)).toBe(false);
    expect(isRoutedControl(result.routed)).toBe(true);
  });

  it('uses the reviewable default environment when none is supplied', () => {
    // The default is conservative: wake word off, mic unpermitted.
    expect(DEFAULT_INTERACTION_ENVIRONMENT.wakeWordEnabled).toBe(false);
    expect(DEFAULT_INTERACTION_ENVIRONMENT.microphonePermission).not.toBe('granted');
    const result = routeActivation({ kind: 'wake_word' });
    expect(result.kind).toBe('refused');
  });
});

describe('interaction routing: capture mute gates every voice activation', () => {
  it('refuses push-to-talk while capture is muted, before any device', () => {
    const result = routeActivation(
      { kind: 'push_to_talk_press' },
      { ...VOICE_READY, captureMuted: true },
    );
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.reason).toBe('capture_muted');
  });

  it('refuses wake-word capture while muted even when the detector is enabled', () => {
    const result = routeActivation(
      { kind: 'wake_word' },
      { ...VOICE_READY, captureMuted: true },
    );
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.reason).toBe('capture_muted');
  });

  it('routes push-to-talk again once capture is unmuted', () => {
    const result = routeActivation(
      { kind: 'push_to_talk_press' },
      { ...VOICE_READY, captureMuted: false },
    );
    expect(result.kind).toBe('routed');
  });

  it('keeps mute distinct from a denied microphone permission', () => {
    const muted = routeActivation(
      { kind: 'push_to_talk_press' },
      { ...VOICE_READY, captureMuted: true },
    );
    const denied = routeActivation(
      { kind: 'push_to_talk_press' },
      { ...VOICE_READY, microphonePermission: 'denied' },
    );
    if (muted.kind !== 'refused' || denied.kind !== 'refused') throw new Error('expected refusals');
    expect(muted.reason).not.toBe(denied.reason);
  });
});
