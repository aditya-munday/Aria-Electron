import { describe, expect, it } from 'vitest';

import { DEFAULT_VOICE_CONFIG, type VoiceRuntimeConfig } from './voice-config.js';
import { VoiceEventBus, type VoiceEvent } from './events.js';
import { VoiceSession } from './session.js';
import { ManualSpeaker } from './playback.js';
import { VoiceError } from './errors.js';
import { FakeMicrophone, tone } from './testing/fake-audio.js';
import { RecordingOrchestrator, SpeechDouble } from './testing/voice-doubles.js';

const FRAME = tone(320, 0.5);

function config(overrides: Partial<VoiceRuntimeConfig> = {}): VoiceRuntimeConfig {
  return {
    ...DEFAULT_VOICE_CONFIG,
    vad: { ...DEFAULT_VOICE_CONFIG.vad, floorAdaptRate: 1, initialFloorDb: -50 },
    minUtteranceMs: 100,
    ...overrides,
  };
}

interface Harness {
  readonly session: VoiceSession;
  readonly microphone: FakeMicrophone;
  readonly speaker: ManualSpeaker;
  readonly speech: SpeechDouble;
  readonly orchestrator: RecordingOrchestrator;
  readonly events: VoiceEvent[];
}

function harness(options: {
  speech?: SpeechDouble;
  orchestrator?: RecordingOrchestrator;
  config?: VoiceRuntimeConfig;
  microphone?: FakeMicrophone;
}): Harness {
  const microphone = options.microphone ?? new FakeMicrophone();
  const speaker = new ManualSpeaker();
  const speech = options.speech ?? new SpeechDouble({ sttText: 'hello world' });
  const orchestrator = options.orchestrator ?? new RecordingOrchestrator();
  const bus = new VoiceEventBus();
  const events: VoiceEvent[] = [];
  bus.on((event) => events.push(event));
  const session = new VoiceSession({
    id: 's1',
    config: options.config ?? config(),
    microphone,
    speaker,
    speech,
    orchestrator,
    events: bus,
    now: () => 0,
  });
  return { session, microphone, speaker, speech, orchestrator, events };
}

function types(events: readonly VoiceEvent[]): string[] {
  return events.map((event) => event.type);
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 2000; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function speakUtterance(h: Harness, frames = 20): Promise<void> {
  for (let i = 0; i < frames; i += 1) h.microphone.lastHandle()?.emit(FRAME);
}

describe('VoiceSession push-to-talk turn', () => {
  it('captures, transcribes, orchestrates, synthesizes and plays the response', async () => {
    const h = harness({});
    const run = h.session.run('push_to_talk');
    await waitFor(() => h.microphone.lastHandle()?.isStarted === true, 'capture start');
    await speakUtterance(h);
    h.session.finalizeUtterance();
    await waitFor(() => types(h.events).includes('playback.started'), 'playback start');
    expect(h.speech.sttCalls).toHaveLength(1);
    expect(h.speech.sttCalls[0]?.audio.sample_rate).toBe(16_000);
    expect(h.speech.sttCalls[0]?.audio.channels).toBe(1);
    expect(h.speech.sttCalls[0]?.audio.samples_le_base64.length).toBeGreaterThan(0);
    expect(h.orchestrator.calls).toEqual([{ text: 'hello world', sessionId: 's1' }]);
    expect(h.speech.ttsCalls).toHaveLength(1);
    h.speaker.advance();
    await run;
    expect(types(h.events)).toContain('response');
    expect(types(h.events)).toContain('playback.finished');
    expect(h.session.response).toBe('response:hello world');
  });

  it('rejects an empty capture without any STT request', async () => {
    const h = harness({});
    const run = h.session.run('push_to_talk');
    await waitFor(() => h.microphone.lastHandle()?.isStarted === true, 'capture start');
    h.session.finalizeUtterance();
    await run;
    expect(h.speech.sttCalls).toHaveLength(0);
    expect(h.orchestrator.calls).toHaveLength(0);
    expect(h.events.find((e) => e.type === 'utterance.rejected')).toMatchObject({ reason: 'empty' });
  });

  it('rejects a too-short capture without any STT request', async () => {
    const h = harness({});
    const run = h.session.run('push_to_talk');
    await waitFor(() => h.microphone.lastHandle()?.isStarted === true, 'capture start');
    h.microphone.lastHandle()?.emit(new Float64Array(320));
    h.session.finalizeUtterance();
    await run;
    expect(h.speech.sttCalls).toHaveLength(0);
    expect(h.events.find((e) => e.type === 'utterance.rejected')).toMatchObject({
      reason: 'too_short',
    });
  });

  it('treats a valid but empty transcription as no request for orchestration', async () => {
    const h = harness({ speech: new SpeechDouble({ sttText: '   ' }) });
    const run = h.session.run('push_to_talk');
    await waitFor(() => h.microphone.lastHandle()?.isStarted === true, 'capture start');
    await speakUtterance(h);
    h.session.finalizeUtterance();
    await run;
    expect(h.speech.sttCalls).toHaveLength(1);
    expect(h.orchestrator.calls).toHaveLength(0);
    expect(h.session.response).toBeUndefined();
  });

  it('fails observably when microphone permission is denied', async () => {
    const h = harness({ microphone: new FakeMicrophone({ permission: 'denied' }) });
    await h.session.run('push_to_talk');
    expect(h.events.find((e) => e.type === 'session.failed')).toMatchObject({
      kind: 'permission_denied',
    });
    expect(h.microphone.openCount).toBe(0);
  });

  it('transitions to a recoverable failed state when the device is lost mid-capture', async () => {
    const h = harness({});
    const run = h.session.run('push_to_talk');
    await waitFor(() => h.microphone.lastHandle()?.isStarted === true, 'capture start');
    await speakUtterance(h, 5);
    h.microphone.lastHandle()?.lose();
    await run;
    expect(h.events.find((e) => e.type === 'session.failed')).toMatchObject({
      kind: 'device_unavailable',
    });
    expect(h.speech.sttCalls).toHaveLength(0);
  });
});

describe('VoiceSession TTS and playback', () => {
  it('does not erase the text response when synthesis fails', async () => {
    const h = harness({
      speech: new SpeechDouble({
        sttText: 'hello',
        ttsError: new VoiceError('speech_failed', 'tts down'),
      }),
    });
    const run = h.session.run('push_to_talk');
    await waitFor(() => h.microphone.lastHandle()?.isStarted === true, 'capture start');
    await speakUtterance(h);
    h.session.finalizeUtterance();
    await run;
    expect(types(h.events)).toContain('response');
    expect(h.session.response).toBe('response:hello');
    expect(
      h.events.find((e) => e.type === 'session.failed' && e.kind === 'speech_failed'),
    ).toBeDefined();
    expect(h.session.currentState).toBe('idle');
  });

  it('does not claim playback when synthesis returns no audio', async () => {
    const h = harness({ speech: new SpeechDouble({ sttText: 'hello', ttsSamples: 0 }) });
    const run = h.session.run('push_to_talk');
    await waitFor(() => h.microphone.lastHandle()?.isStarted === true, 'capture start');
    await speakUtterance(h);
    h.session.finalizeUtterance();
    await run;
    expect(types(h.events)).not.toContain('playback.started');
    expect(types(h.events)).toContain('response');
  });

  it('skips synthesis entirely when spoken responses are disabled, keeping the text', async () => {
    const h = harness({ config: config({ speakResponses: false }) });
    const run = h.session.run('push_to_talk');
    await waitFor(() => h.microphone.lastHandle()?.isStarted === true, 'capture start');
    await speakUtterance(h);
    h.session.finalizeUtterance();
    await run;
    expect(h.speech.ttsCalls).toHaveLength(0);
    expect(types(h.events)).toContain('response');
    expect(h.session.response).toBe('response:hello world');
  });

  it('interrupts playback without waiting for natural completion', async () => {
    const h = harness({});
    const run = h.session.run('push_to_talk');
    await waitFor(() => h.microphone.lastHandle()?.isStarted === true, 'capture start');
    await speakUtterance(h);
    h.session.finalizeUtterance();
    await waitFor(() => types(h.events).includes('playback.started'), 'playback start');
    expect(h.speaker.isPlaying()).toBe(true);
    await h.session.cancel('interrupted');
    await run;
    expect(types(h.events)).toContain('playback.interrupted');
    expect(types(h.events)).toContain('session.cancelled');
    expect(h.speaker.isPlaying()).toBe(false);
  });

  it('fails observably when the device is removed during playback', async () => {
    const h = harness({});
    const run = h.session.run('push_to_talk');
    await waitFor(() => h.microphone.lastHandle()?.isStarted === true, 'capture start');
    await speakUtterance(h);
    h.session.finalizeUtterance();
    await waitFor(() => types(h.events).includes('playback.started'), 'playback start');
    h.speaker.fail();
    await run;
    expect(
      h.events.find((e) => e.type === 'session.failed' && e.kind === 'playback_failed'),
    ).toBeDefined();
    expect(h.session.response).toBe('response:hello world');
  });
});

describe('VoiceSession orchestration failure', () => {
  it('keeps the transcript and reports the failure when orchestration fails', async () => {
    const h = harness({
      orchestrator: new RecordingOrchestrator({
        error: new VoiceError('backend_unavailable', 'chat down'),
      }),
    });
    const run = h.session.run('push_to_talk');
    await waitFor(() => h.microphone.lastHandle()?.isStarted === true, 'capture start');
    await speakUtterance(h);
    h.session.finalizeUtterance();
    await run;
    expect(h.events.find((e) => e.type === 'transcript' && e.text === 'hello world')).toBeDefined();
    expect(h.events.find((e) => e.type === 'session.failed')).toMatchObject({
      kind: 'backend_unavailable',
    });
    expect(types(h.events)).not.toContain('response');
    expect(h.speech.ttsCalls).toHaveLength(0);
    expect(h.session.response).toBeUndefined();
    expect(h.session.currentState).toBe('idle');
  });

  it('keeps a typed turn alive when orchestration fails', async () => {
    const h = harness({
      orchestrator: new RecordingOrchestrator({
        error: new VoiceError('backend_unavailable', 'chat down'),
      }),
    });
    await h.session.runText('typed input');
    expect(h.events.find((e) => e.type === 'transcript' && e.text === 'typed input')).toBeDefined();
    expect(h.events.find((e) => e.type === 'session.failed')).toMatchObject({
      kind: 'backend_unavailable',
    });
    expect(h.session.currentState).toBe('idle');
  });

  it('a cancellation during orchestration is a clean stop, not a failure', async () => {
    const h = harness({
      orchestrator: new RecordingOrchestrator({ delayTicks: 400 }),
    });
    const run = h.session.run('push_to_talk');
    await waitFor(() => h.microphone.lastHandle()?.isStarted === true, 'capture start');
    await speakUtterance(h);
    h.session.finalizeUtterance();
    await waitFor(() => h.orchestrator.calls.length === 1, 'orchestration start');
    await h.session.cancel('superseded');
    await run;
    expect(types(h.events)).toContain('session.cancelled');
    expect(h.events.find((e) => e.type === 'session.failed')).toBeUndefined();
    expect(h.session.currentState).toBe('cancelled');
  });
});

describe('VoiceSession cancellation and stale results', () => {
  it('a cancelled turn does not call orchestration after STT resolves late', async () => {
    const h = harness({ speech: new SpeechDouble({ sttText: 'late', sttDelayTicks: 400 }) });
    const run = h.session.run('push_to_talk');
    await waitFor(() => h.microphone.lastHandle()?.isStarted === true, 'capture start');
    await speakUtterance(h);
    h.session.finalizeUtterance();
    await waitFor(() => h.speech.sttCalls.length === 1, 'stt start');
    await h.session.cancel('superseded');
    await run;
    expect(h.orchestrator.calls).toHaveLength(0);
    expect(types(h.events)).toContain('session.cancelled');
  });

  it('a text turn goes straight to orchestration, bypassing STT', async () => {
    const h = harness({});
    const run = h.session.runText('typed input');
    await waitFor(() => types(h.events).includes('playback.started'), 'playback start');
    expect(h.speech.sttCalls).toHaveLength(0);
    expect(h.orchestrator.calls).toEqual([{ text: 'typed input', sessionId: 's1' }]);
    h.speaker.advance();
    await run;
    expect(types(h.events)).toContain('response');
  });

  it('threads an advisory route hint from the orchestrator onto the response', async () => {
    const route = { capability: 'deploy.service', requires_confirmation: true };
    const h = harness({ orchestrator: new RecordingOrchestrator({ route }) });
    const run = h.session.runText('deploy the api');
    await waitFor(() => types(h.events).includes('playback.started'), 'playback start');
    h.speaker.advance();
    await run;
    const response = h.events.find((e) => e.type === 'response');
    expect(response).toMatchObject({ text: 'response:deploy the api', route });
    expect(h.session.route).toEqual(route);
  });

  it('leaves the route undefined when the Backend sent no hint', async () => {
    const h = harness({});
    const run = h.session.runText('just talking');
    await waitFor(() => types(h.events).includes('playback.started'), 'playback start');
    h.speaker.advance();
    await run;
    const response = h.events.find((e) => e.type === 'response');
    expect(response?.type === 'response' && response.route).toBeFalsy();
    expect(h.session.route).toBeUndefined();
  });
});
