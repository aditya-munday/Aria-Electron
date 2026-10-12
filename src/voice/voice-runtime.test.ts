import { describe, expect, it } from 'vitest';

import { DEFAULT_VOICE_CONFIG, type VoiceRuntimeConfig } from './voice-config.js';
import { VoiceRuntime } from './voice-runtime.js';
import { ManualSpeaker } from './playback.js';
import type { VoiceEvent } from './events.js';
import { VoiceError } from './errors.js';
import { FakeMicrophone, tone } from './testing/fake-audio.js';
import { FakeWakeWordDetector, RecordingOrchestrator, SpeechDouble, manualClock } from './testing/voice-doubles.js';

const FRAME = tone(320, 0.5);

function config(overrides: Partial<VoiceRuntimeConfig> = {}): VoiceRuntimeConfig {
  return {
    ...DEFAULT_VOICE_CONFIG,
    vad: { ...DEFAULT_VOICE_CONFIG.vad, floorAdaptRate: 1, initialFloorDb: -50 },
    minUtteranceMs: 100,
    pushToTalk: { ...DEFAULT_VOICE_CONFIG.pushToTalk, minPressMs: 100 },
    ...overrides,
  };
}

interface Built {
  runtime: VoiceRuntime;
  microphone: FakeMicrophone;
  speaker: ManualSpeaker;
  speech: SpeechDouble;
  orchestrator: RecordingOrchestrator;
  events: VoiceEvent[];
  clock: ReturnType<typeof manualClock>;
}

function build(options: {
  config?: VoiceRuntimeConfig;
  microphone?: FakeMicrophone;
  speech?: SpeechDouble;
  detector?: FakeWakeWordDetector | null;
  orchestrator?: RecordingOrchestrator;
} = {}): Built {
  const clock = manualClock();
  const microphone = options.microphone ?? new FakeMicrophone();
  const speaker = new ManualSpeaker();
  const speech = options.speech ?? new SpeechDouble({ sttText: 'hello world' });
  const orchestrator = options.orchestrator ?? new RecordingOrchestrator();
  const events: VoiceEvent[] = [];
  const runtime = new VoiceRuntime({
    config: options.config ?? config(),
    microphone,
    speaker,
    speech,
    orchestrator,
    now: clock.now,
    ...(options.detector !== undefined ? { wakeWordDetector: options.detector } : {}),
  });
  runtime.on((event) => events.push(event));
  return { runtime, microphone, speaker, speech, orchestrator, events, clock };
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

describe('VoiceRuntime push-to-talk', () => {
  it('begins capture immediately on press without consulting a wake-word detector', async () => {
    const detector = new FakeWakeWordDetector({ id: 'spy' });
    const built = build({ detector });
    await built.runtime.pushToTalkPress();
    await waitFor(() => built.microphone.openCount === 1, 'capture open');
    expect(built.microphone.lastHandle()?.isStarted).toBe(true);
    expect(detector.pushCount()).toBe(0);
  });

  it('works when the wake-word detector is disabled or unavailable', async () => {
    const built = build({ detector: null });
    await built.runtime.pushToTalkPress();
    await waitFor(() => built.microphone.openCount === 1, 'capture open');
    expect(types(built.events)).toContain('capture.started');
    expect(built.runtime.diagnostics().wakeWordEnabled).toBe(false);
  });

  it('finalizes the utterance on release and completes the turn', async () => {
    const built = build({});
    await built.runtime.pushToTalkPress();
    await waitFor(() => built.microphone.lastHandle()?.isStarted === true, 'capture start');
    for (let i = 0; i < 20; i += 1) built.microphone.lastHandle()?.emit(FRAME);
    built.clock.advance(500);
    await built.runtime.pushToTalkRelease();
    await waitFor(() => types(built.events).includes('playback.started'), 'playback');
    built.speaker.advance();
    await waitFor(() => types(built.events).includes('playback.finished'), 'finished');
    expect(built.orchestrator.calls[0]?.text).toBe('hello world');
  });

  it('cancels an accidental short press without submitting', async () => {
    const built = build({});
    await built.runtime.pushToTalkPress();
    await waitFor(() => built.microphone.openCount === 1, 'capture open');
    built.clock.advance(20);
    await built.runtime.pushToTalkRelease();
    await waitFor(() => types(built.events).includes('session.cancelled'), 'cancel');
    expect(built.speech.sttCalls).toHaveLength(0);
    expect(built.orchestrator.calls).toHaveLength(0);
  });

  it('does not open capture when push-to-talk is disabled', async () => {
    const built = build({
      config: config({ pushToTalk: { ...DEFAULT_VOICE_CONFIG.pushToTalk, enabled: false } }),
    });
    await built.runtime.pushToTalkPress();
    expect(built.microphone.openCount).toBe(0);
  });
});

describe('VoiceRuntime wake word', () => {
  it('activates a session from a local detection and emits an activation event', async () => {
    const detector = new FakeWakeWordDetector({
      id: 'local-detector',
      model: 'model-v1',
      repeatDetection: { phrase: 'hey aria', confidence: 0.95 },
    });
    const built = build({
      config: config({ wakeWord: { ...DEFAULT_VOICE_CONFIG.wakeWord, enabled: true } }),
      detector,
    });
    await built.runtime.start();
    await waitFor(() => built.runtime.diagnostics().listening, 'listening');
    // Feed a wake frame; the listener detects and opens a session.
    built.microphone.lastHandle()?.emit(FRAME);
    await waitFor(() => types(built.events).includes('wake.detected'), 'wake detected');
    await waitFor(() => types(built.events).includes('capture.started'), 'session capture');
    expect(built.runtime.diagnostics().wakeWordModel).toBe('model-v1');
  });

  it('does not create duplicate sessions from a sustained detection', async () => {
    const detector = new FakeWakeWordDetector({
      id: 'local-detector',
      repeatDetection: { phrase: 'hey aria', confidence: 0.95 },
    });
    const built = build({
      config: config({
        wakeWord: { ...DEFAULT_VOICE_CONFIG.wakeWord, enabled: true, cooldownMs: 1_000 },
      }),
      detector,
    });
    await built.runtime.start();
    await waitFor(() => built.runtime.diagnostics().listening, 'listening');
    built.microphone.lastHandle()?.emit(FRAME);
    await waitFor(() => types(built.events).includes('wake.detected'), 'first detection');
    // More frames while a session is active do not start another.
    built.microphone.lastHandle()?.emit(FRAME);
    built.microphone.lastHandle()?.emit(FRAME);
    const activations = built.events.filter((e) => e.type === 'session.started');
    expect(activations).toHaveLength(1);
  });

  it('reports a detector init failure and keeps push-to-talk available', async () => {
    const detector = new FakeWakeWordDetector({ initError: new Error('model missing') });
    const built = build({
      config: config({ wakeWord: { ...DEFAULT_VOICE_CONFIG.wakeWord, enabled: true } }),
      detector,
    });
    await built.runtime.start();
    const diag = built.runtime.diagnostics();
    expect(diag.wakeWordStatus).toBe('failed');
    expect(diag.wakeWordFailure).toBe('model missing');
    // Push-to-talk still works.
    await built.runtime.pushToTalkPress();
    await waitFor(() => built.microphone.openCount >= 1, 'ptt capture');
  });
});

describe('VoiceRuntime session ownership', () => {
  it('cancels the previous session when a new activation arrives', async () => {
    const built = build({});
    await built.runtime.pushToTalkPress();
    await waitFor(() => built.microphone.lastHandle()?.isStarted === true, 'first capture');
    for (let i = 0; i < 5; i += 1) built.microphone.lastHandle()?.emit(FRAME);
    built.clock.advance(300);
    const turn = built.runtime.sendText('a new turn');
    await waitFor(
      () => built.events.filter((e) => e.type === 'session.started').length === 2,
      'second session',
    );
    await waitFor(() => types(built.events).includes('session.cancelled'), 'cancel');
    const started = built.events.filter((e) => e.type === 'session.started');
    expect(started).toHaveLength(2);
    await waitFor(() => types(built.events).includes('playback.started'), 'playback');
    built.speaker.advance();
    await turn;
  });

  it('rejects a new activation under the reject policy', async () => {
    const built = build({ config: config({ conflictPolicy: 'reject_new' }) });
    await built.runtime.pushToTalkPress();
    await waitFor(() => built.microphone.openCount === 1, 'first capture');
    await built.runtime.sendText('a new turn');
    expect(built.runtime.diagnostics().lastError?.kind).toBe('session_conflict');
    expect(built.events.filter((e) => e.type === 'session.started')).toHaveLength(1);
  });

  it('interrupt stops playback without cancelling the runtime', async () => {
    const built = build({});
    await built.runtime.pushToTalkPress();
    await waitFor(() => built.microphone.lastHandle()?.isStarted === true, 'capture start');
    for (let i = 0; i < 20; i += 1) built.microphone.lastHandle()?.emit(FRAME);
    built.clock.advance(300);
    await built.runtime.pushToTalkRelease();
    await waitFor(() => types(built.events).includes('playback.started'), 'playback');
    await built.runtime.interrupt();
    expect(types(built.events)).toContain('playback.interrupted');
    expect(built.speaker.isPlaying()).toBe(false);
  });

  it('rapid repeated activation does not leave concurrent captures running', async () => {
    const built = build({});
    for (let i = 0; i < 5; i += 1) {
      await built.runtime.pushToTalkPress();
      built.clock.advance(300);
      await built.runtime.pushToTalkRelease();
    }
    await waitFor(
      () => built.microphone.handles.every((handle) => !handle.isStarted),
      'all captures stopped',
    );
    const live = built.microphone.handles.filter((handle) => handle.isStarted);
    expect(live).toHaveLength(0);
  });
});

describe('VoiceRuntime text turn', () => {
  it('routes typed input to orchestration without capture or STT', async () => {
    const built = build({});
    const turn = built.runtime.sendText('typed');
    await waitFor(() => types(built.events).includes('playback.started'), 'playback');
    expect(built.microphone.openCount).toBe(0);
    expect(built.speech.sttCalls).toHaveLength(0);
    expect(built.orchestrator.calls).toEqual([{ text: 'typed', sessionId: 'voice-1' }]);
    built.speaker.advance();
    await turn;
  });

  it('ignores empty typed input', async () => {
    const built = build({});
    await built.runtime.sendText('   ');
    expect(built.orchestrator.calls).toHaveLength(0);
  });

  it('returns the reply text so a caller can read the response', async () => {
    const built = build({});
    const turn = built.runtime.sendText('typed');
    await waitFor(() => types(built.events).includes('playback.started'), 'playback');
    built.speaker.advance();
    const reply = await turn;
    expect(reply.text).toBe('response:typed');
  });

  it('carries the advisory route hint back to the caller', async () => {
    const route = { capability: 'deploy.service', requires_confirmation: true };
    const built = build({ orchestrator: new RecordingOrchestrator({ route }) });
    const turn = built.runtime.sendText('deploy the api');
    await waitFor(() => types(built.events).includes('playback.started'), 'playback');
    built.speaker.advance();
    const reply = await turn;
    expect(reply.route).toEqual(route);
  });
});

describe('VoiceRuntime speech output', () => {
  it('applies a new voice and language to the next synthesized turn', async () => {
    const built = build({});
    built.runtime.setSpeechOutput({ voice: 'magnus', language: 'en-GB' });
    const turn = built.runtime.sendText('hello');
    await waitFor(() => types(built.events).includes('playback.started'), 'playback');
    built.speaker.advance();
    await turn;
    expect(built.speech.ttsCalls[0]).toMatchObject({ voice: 'magnus', language: 'en-GB' });
  });

  it('clamps an out-of-range speed instead of sending it to the Backend', async () => {
    const built = build({});
    built.runtime.setSpeechOutput({ speed: 9 });
    const turn = built.runtime.sendText('hello');
    await waitFor(() => types(built.events).includes('playback.started'), 'playback');
    built.speaker.advance();
    await turn;
    expect(built.speech.ttsCalls[0]?.speed).toBe(2);
  });

  it('clears the voice so the Backend default is used', async () => {
    const built = build({ config: config({ voice: 'magnus' }) });
    built.runtime.setSpeechOutput({ voice: null });
    const turn = built.runtime.sendText('hello');
    await waitFor(() => types(built.events).includes('playback.started'), 'playback');
    built.speaker.advance();
    await turn;
    expect(built.speech.ttsCalls[0]?.voice).toBeUndefined();
  });

  it('auditions a voice without opening a session or capturing audio', async () => {
    const built = build({});
    const preview = built.runtime.previewSpeech({ text: 'hi', voice: 'vera', speed: 1.2 });
    await waitFor(() => built.speech.ttsCalls.length === 1, 'synthesis');
    built.speaker.advance();
    await preview;
    expect(built.speech.ttsCalls[0]).toMatchObject({ text: 'hi', voice: 'vera', speed: 1.2 });
    expect(built.microphone.openCount).toBe(0);
    expect(built.orchestrator.calls).toHaveLength(0);
  });

  it('does not synthesize an empty preview', async () => {
    const built = build({});
    await built.runtime.previewSpeech({ text: '   ' });
    expect(built.speech.ttsCalls).toHaveLength(0);
  });

  it('rejects a preview when the Backend returns no audio', async () => {
    const built = build({ speech: new SpeechDouble({ ttsSamples: 0 }) });
    await expect(built.runtime.previewSpeech({ text: 'hi' })).rejects.toThrow(VoiceError);
  });
});

describe('VoiceRuntime voice discovery', () => {
  it('flags a configured voice the Backend does not offer', async () => {
    const built = build({ config: config({ voice: 'nope' }) });
    await built.runtime.discoverVoices([{ id: 'magnus' }, { id: 'vera' }]);
    expect(built.runtime.diagnostics().lastError?.kind).toBe('invalid_configuration');
    expect(built.runtime.diagnostics().lastError?.message).toContain('nope');
  });

  it('accepts a configured voice the Backend offers', async () => {
    const built = build({ config: config({ voice: 'magnus' }) });
    await built.runtime.discoverVoices([{ id: 'magnus' }]);
    expect(built.runtime.diagnostics().lastError).toBeUndefined();
  });

  it('does not treat an empty catalog as proof the voice is missing', async () => {
    const built = build({ config: config({ voice: 'magnus' }) });
    await built.runtime.discoverVoices([]);
    expect(built.runtime.diagnostics().lastError).toBeUndefined();
  });
});

describe('VoiceRuntime backend outage', () => {
  it('does not disable local activation when the backend is unavailable', async () => {
    const speech = new SpeechDouble({ sttError: new VoiceError('backend_unavailable', 'down') });
    const built = build({ speech });
    await built.runtime.pushToTalkPress();
    await waitFor(() => built.microphone.lastHandle()?.isStarted === true, 'capture start');
    for (let i = 0; i < 20; i += 1) built.microphone.lastHandle()?.emit(FRAME);
    built.clock.advance(300);
    await built.runtime.pushToTalkRelease();
    await waitFor(
      () => built.events.some((e) => e.type === 'session.failed' && e.kind === 'backend_unavailable'),
      'backend failure',
    );
    // A new push-to-talk still captures.
    await built.runtime.pushToTalkPress();
    await waitFor(() => built.microphone.openCount === 2, 'second capture');
  });
});
