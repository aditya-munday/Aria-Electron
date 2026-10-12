import { describe, expect, it } from 'vitest';

import { AriaRuntime } from './runtime.js';
import { DEFAULT_VOICE_CONFIG } from './voice/voice-config.js';
import { ManualSpeaker } from './voice/playback.js';
import { FakeMicrophone, tone } from './voice/testing/fake-audio.js';
import { FakeWakeWordDetector } from './voice/testing/voice-doubles.js';

/**
 * An end-to-end wiring test: the real `TaskClient` and `FetchTransport` run
 * against a fake `fetch` that speaks the Backend's wire shapes. Nothing in the
 * client or supervisor is mocked.
 */
function backendFetch(): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const method = (init.method ?? 'GET') as string;
    const path = new URL(url).pathname;
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (method === 'GET' && path === '/api/v1/me') {
      return json(200, {
        identity: { userId: 'u1', roles: ['user'], providers: ['email'], anonymous: false },
      });
    }
    if (method === 'POST' && path === '/api/v1/tasks') {
      return json(201, {
        task: {
          id: 't1',
          userId: 'u1',
          title: 'deploy',
          status: 'draft',
          version: 1,
          createdAt: '2026-10-10T00:00:00.000Z',
          updatedAt: '2026-10-10T00:00:00.000Z',
        },
      });
    }
    if (method === 'POST' && path === '/api/v1/approvals') {
      return json(201, {
        approval: {
          id: 'a1',
          taskId: 't1',
          userId: 'u1',
          requestedBy: 'u1',
          decision: null,
          createdAt: '2026-10-10T00:00:00.000Z',
        },
        task: {
          id: 't1',
          userId: 'u1',
          title: 'deploy',
          status: 'awaiting_approval',
          version: 2,
          createdAt: '2026-10-10T00:00:00.000Z',
          updatedAt: '2026-10-10T00:00:00.000Z',
        },
      });
    }
    return json(404, { error: { code: 'NOT_FOUND', message: `no route for ${method} ${path}` } });
  }) as unknown as typeof fetch;
}

/**
 * A fake `fetch` that speaks the whole Aria `/v1` surface the voice runtime uses:
 * chat, STT and TTS. The real `AriaClient`, `BackendSpeechProxy` and
 * `ChatOrchestrator` run unchanged against it.
 */
function ariaVoiceFetch(seen: { chat: number; stt: number; tts: number }): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const method = (init.method ?? 'GET') as string;
    const path = new URL(url).pathname;
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (method === 'POST' && path === '/v1/chat') {
      seen.chat += 1;
      return json(200, { contract_version: 1, text: 'the answer is forty two' });
    }
    if (method === 'POST' && path === '/v1/stt') {
      seen.stt += 1;
      return json(200, { contract_version: 1, text: 'what is the answer' });
    }
    if (method === 'POST' && path === '/v1/tts') {
      seen.tts += 1;
      return json(200, {
        contract_version: 1,
        audio: { sample_rate: 16_000, channels: 1, samples_le_base64: 'AAAAAA==' },
      });
    }
    if (method === 'GET' && path === '/v1/capabilities') {
      return json(200, {
        contract_version: 1,
        backend_version: 'test/1',
        stt_languages: ['en'],
        tts_languages: ['en'],
        voices: [{ id: 'magnus', name: 'Magnus', language: 'en' }],
        streaming_stt: false,
        streaming_chat: true,
        streaming_tts: false,
      });
    }
    return json(404, { error: { code: 'NOT_FOUND', message: `no route for ${method} ${path}` } });
  }) as unknown as typeof fetch;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 2000; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('AriaRuntime', () => {
  it('is not signed in until a session token is set', () => {
    const runtime = new AriaRuntime({
      config: { backendBaseUrl: 'https://api.test', requestTimeoutMs: 1000 },
      fetchImpl: backendFetch(),
    });
    expect(runtime.isSignedIn()).toBe(false);
    runtime.setSessionToken('tok');
    expect(runtime.isSignedIn()).toBe(true);
  });

  it('submits a request through the real client and returns an accepted task', async () => {
    const runtime = new AriaRuntime({
      config: { backendBaseUrl: 'https://api.test', requestTimeoutMs: 1000 },
      fetchImpl: backendFetch(),
    });
    runtime.start();
    runtime.setSessionToken('tok');
    const record = await runtime.supervisor.submitRequest({ title: 'deploy' });
    expect(record.status).toBe('awaiting_approval');
    expect(runtime.supervisor.phaseOf(record.taskId)).toBe('accepted');
  });

  it('signing out makes the next call fail as no_token, not as a backend error', async () => {
    const runtime = new AriaRuntime({
      config: { backendBaseUrl: 'https://api.test', requestTimeoutMs: 1000 },
      fetchImpl: backendFetch(),
    });
    runtime.start();
    await expect(runtime.supervisor.submitRequest({ title: 'deploy' })).rejects.toMatchObject({
      kind: 'backend',
      message: 'Sign in to reach the Directioner backend.',
    });
  });

  it('drives a full voice turn end to end through the real /v1 client', async () => {
    const seen = { chat: 0, stt: 0, tts: 0 };
    const microphone = new FakeMicrophone();
    const speaker = new ManualSpeaker();
    const runtime = new AriaRuntime({
      config: { backendBaseUrl: 'https://api.test', requestTimeoutMs: 1000 },
      fetchImpl: ariaVoiceFetch(seen),
      microphone,
      speaker,
      voiceConfig: {
        ...DEFAULT_VOICE_CONFIG,
        minUtteranceMs: 100,
        vad: { ...DEFAULT_VOICE_CONFIG.vad, floorAdaptRate: 1, initialFloorDb: -50 },
        pushToTalk: { ...DEFAULT_VOICE_CONFIG.pushToTalk, minPressMs: 0 },
      },
    });
    runtime.setSessionToken('tok');
    const voice = runtime.voice;
    expect(voice).toBeDefined();
    const events: string[] = [];
    let responseText: string | undefined;
    voice?.on((event) => {
      events.push(event.type);
      if (event.type === 'response') responseText = event.text;
    });

    await voice?.pushToTalkPress();
    await waitFor(() => microphone.lastHandle()?.isStarted === true, 'capture');
    for (let i = 0; i < 20; i += 1) microphone.lastHandle()?.emit(tone(320, 0.5));
    await voice?.pushToTalkRelease();
    await waitFor(() => events.includes('playback.started'), 'playback');
    expect(seen.stt).toBe(1);
    expect(seen.chat).toBe(1);
    expect(seen.tts).toBe(1);
    expect(responseText).toBe('the answer is forty two');
    speaker.advance();
    await waitFor(() => events.includes('playback.finished'), 'finished');
    expect(events).toContain('transcript');
  });

  it('starts wake-word listening through the runtime composition', async () => {
    const detector = new FakeWakeWordDetector({
      id: 'local',
      model: 'model-v1',
      repeatDetection: { phrase: 'hey aria', confidence: 0.9 },
    });
    const microphone = new FakeMicrophone();
    const runtime = new AriaRuntime({
      config: { backendBaseUrl: 'https://api.test', requestTimeoutMs: 1000 },
      fetchImpl: ariaVoiceFetch({ chat: 0, stt: 0, tts: 0 }),
      microphone,
      speaker: new ManualSpeaker(),
      wakeWordDetector: detector,
      voiceConfig: {
        ...DEFAULT_VOICE_CONFIG,
        wakeWord: { ...DEFAULT_VOICE_CONFIG.wakeWord, enabled: true },
      },
    });
    await runtime.startVoice();
    expect(runtime.voice?.diagnostics().listening).toBe(true);
    microphone.lastHandle()?.emit(tone(320, 0.5));
    await waitFor(
      () => runtime.voice?.diagnostics().sessionState === 'capturing',
      'session from wake word',
    );
  });

  it('reconciles the configured voice with the Backend capabilities on start', async () => {
    const runtime = new AriaRuntime({
      config: { backendBaseUrl: 'https://api.test', requestTimeoutMs: 1000 },
      fetchImpl: ariaVoiceFetch({ chat: 0, stt: 0, tts: 0 }),
      microphone: new FakeMicrophone(),
      speaker: new ManualSpeaker(),
      voiceConfig: { ...DEFAULT_VOICE_CONFIG, voice: 'not-offered' },
    });
    await runtime.startVoice();
    expect(runtime.voice?.diagnostics().lastError?.kind).toBe('invalid_configuration');
  });

describe('AriaRuntime session', () => {
  it('seeds the session token from the option without signing in by default', () => {
    const signedOut = new AriaRuntime({ config: { backendBaseUrl: 'https://api.adityamunday.codes', requestTimeoutMs: 1000, model: { provider: 'groq', id: 'groq/llama-3.3-70b-versatile', displayName: 'Llama 3.3 70B (Groq)' } } });
    expect(signedOut.isSignedIn()).toBe(false);
    const seeded = new AriaRuntime({
      config: { backendBaseUrl: 'https://api.adityamunday.codes', requestTimeoutMs: 1000, model: { provider: 'groq', id: 'groq/llama-3.3-70b-versatile', displayName: 'Llama 3.3 70B (Groq)' } },
      sessionToken: 'tok-1',
    });
    expect(seeded.isSignedIn()).toBe(true);
    seeded.setSessionToken(undefined);
    expect(seeded.isSignedIn()).toBe(false);
  });
});

});
