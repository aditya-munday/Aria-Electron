import { describe, expect, it } from 'vitest';

import { InteractionController, type InteractionRuntime } from './interaction-controller.js';
import type { InteractionEnvironment } from './interaction-router.js';

/** A recording double for the execution seam: it logs what was actually run. */
class RecordingRuntime implements InteractionRuntime {
  readonly calls: string[] = [];
  pushToTalkPress(): void {
    this.calls.push('press');
  }
  pushToTalkRelease(): void {
    this.calls.push('release');
  }
  sendText(text: string): void {
    this.calls.push(`sendText:${text}`);
  }
  interrupt(): void {
    this.calls.push('interrupt');
  }
}

function env(overrides: Partial<InteractionEnvironment> = {}): InteractionEnvironment {
  return {
    wakeWordEnabled: true,
    microphonePermission: 'granted',
    voiceSessionActive: false,
    ...overrides,
  };
}

describe('interaction controller: voice-input protection', () => {
  it('starts push-to-talk capture immediately, without consulting wake-word detection', async () => {
    const runtime = new RecordingRuntime();
    // Wake word is disabled and unpermitted: push-to-talk must still work,
    // because it never depends on wake-word detection or its model.
    const controller = new InteractionController({
      environment: env({ wakeWordEnabled: false, microphonePermission: 'granted' }),
      runtime,
    });
    const result = await controller.handle({ kind: 'push_to_talk_press' });
    expect(result.kind).toBe('routed');
    expect(runtime.calls).toEqual(['press']);
  });

  it('does not start push-to-talk capture without microphone permission', async () => {
    const runtime = new RecordingRuntime();
    const controller = new InteractionController({
      environment: env({ microphonePermission: 'denied' }),
      runtime,
    });
    const result = await controller.handle({ kind: 'push_to_talk_press' });
    expect(result).toMatchObject({ kind: 'refused', reason: 'microphone_not_permitted' });
    // A refused routing must touch no device and run nothing.
    expect(runtime.calls).toEqual([]);
  });

  it('never captures for the wake word while detection is disabled', async () => {
    const runtime = new RecordingRuntime();
    const controller = new InteractionController({
      environment: env({ wakeWordEnabled: false }),
      runtime,
    });
    const result = await controller.handle({ kind: 'wake_word' });
    expect(result).toMatchObject({ kind: 'refused', reason: 'wake_word_disabled' });
    expect(runtime.calls).toEqual([]);
  });

  it('never captures for the wake word while the microphone is unpermitted', async () => {
    const runtime = new RecordingRuntime();
    const controller = new InteractionController({
      environment: env({ wakeWordEnabled: true, microphonePermission: 'prompt' }),
      runtime,
    });
    const result = await controller.handle({ kind: 'wake_word' });
    expect(result).toMatchObject({ kind: 'refused', reason: 'microphone_not_permitted' });
    expect(runtime.calls).toEqual([]);
  });

  it('does not let a wake-word activation start capture during an active voice session', async () => {
    const runtime = new RecordingRuntime();
    const controller = new InteractionController({
      environment: env({ voiceSessionActive: true }),
      runtime,
    });
    const result = await controller.handle({ kind: 'wake_word' });
    expect(result).toMatchObject({ kind: 'refused', reason: 'voice_session_active' });
    expect(runtime.calls).toEqual([]);
  });

  it('opens the chat window with Win+Alt+A and starts no microphone capture', async () => {
    const runtime = new RecordingRuntime();
    const controller = new InteractionController({ environment: env(), runtime });
    const result = await controller.handle({ kind: 'chat_shortcut' });
    expect(result.kind).toBe('routed');
    if (result.kind === 'routed' && 'surface' in result.routed) {
      expect(result.routed.surface).toBe('chat');
      expect(result.routed.capture).toBe(false);
    }
    expect(runtime.calls).toEqual([]);
  });

  it('routes typed text to the runtime with STT bypassed', async () => {
    const runtime = new RecordingRuntime();
    const controller = new InteractionController({ environment: env(), runtime });
    await controller.handle({ kind: 'typed_text', text: '  ship it  ' });
    expect(runtime.calls).toEqual(['sendText:ship it']);
  });

  it('executes nothing at all for a normal app launch', async () => {
    const runtime = new RecordingRuntime();
    const controller = new InteractionController({ environment: env(), runtime });
    await controller.handle({ kind: 'app_launch' });
    expect(runtime.calls).toEqual([]);
  });

  it('reads the environment live, so a permission change is honoured', async () => {
    const runtime = new RecordingRuntime();
    let permission: InteractionEnvironment['microphonePermission'] = 'denied';
    const controller = new InteractionController({
      environment: () => env({ microphonePermission: permission }),
      runtime,
    });
    const denied = await controller.handle({ kind: 'push_to_talk_press' });
    expect(denied.kind).toBe('refused');
    permission = 'granted';
    const allowed = await controller.handle({ kind: 'push_to_talk_press' });
    expect(allowed.kind).toBe('routed');
    expect(runtime.calls).toEqual(['press']);
  });
});
