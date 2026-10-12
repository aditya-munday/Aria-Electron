import { describe, expect, it } from 'vitest';

import { AriaClient } from '../backend/aria-client.js';
import { InMemoryTransport, SharedToken } from '../backend/transport.js';
import { ARIA_ENDPOINTS } from '../contract/aria-contract.js';
import { BackendSpeechProxy, voiceErrorFromBackend } from './speech.js';
import { ariaError } from '../backend/product-errors.js';
import { VoiceError } from './errors.js';

function proxy(transport: InMemoryTransport): BackendSpeechProxy {
  const tokens = new SharedToken('session-token');
  const client = new AriaClient({ transport, tokens });
  return new BackendSpeechProxy(client);
}

const AUDIO = { sample_rate: 16_000, channels: 1, samples_le_base64: 'AQACAAMABAA=' };

describe('BackendSpeechProxy speech-to-text contract', () => {
  it('submits the Aria /v1/stt request and returns the transcript', async () => {
    const transport = new InMemoryTransport().on({
      method: 'POST',
      path: ARIA_ENDPOINTS.stt,
      status: 200,
      body: { contract_version: 1, text: 'hello world', language: 'en' },
    });
    const result = await proxy(transport).transcribe({ audio: AUDIO });
    expect(result.text).toBe('hello world');
    const call = transport.recorded()[0];
    expect(call?.path).toBe('/v1/stt');
    expect(call?.body).toMatchObject({ contract_version: 1, audio: AUDIO });
  });

  it('distinguishes a rejected/unauthorized request from an outage', async () => {
    const transport = new InMemoryTransport().on({
      method: 'POST',
      path: ARIA_ENDPOINTS.stt,
      status: 401,
      body: { contract_version: 1, code: 'unauthenticated', message: 'sign in' },
    });
    await expect(proxy(transport).transcribe({ audio: AUDIO })).rejects.toMatchObject({
      kind: 'not_signed_in',
    });
  });

  it('maps a backend outage (503) to backend_unavailable and a provider failure (502) to speech_failed', async () => {
    const outage = new InMemoryTransport().on({
      method: 'POST',
      path: ARIA_ENDPOINTS.stt,
      status: 503,
      body: { contract_version: 1, code: 'service_unavailable', message: 'down' },
    });
    await expect(proxy(outage).transcribe({ audio: AUDIO })).rejects.toMatchObject({
      kind: 'backend_unavailable',
    });
    const provider = new InMemoryTransport().on({
      method: 'POST',
      path: ARIA_ENDPOINTS.stt,
      status: 502,
      body: { contract_version: 1, code: 'upstream_unavailable', message: 'provider' },
    });
    await expect(proxy(provider).transcribe({ audio: AUDIO })).rejects.toMatchObject({
      kind: 'speech_failed',
    });
  });

  it('reports an unreachable backend as a transport failure, never a success', async () => {
    const transport = new InMemoryTransport().failAll('connection refused');
    await expect(proxy(transport).transcribe({ audio: AUDIO })).rejects.toMatchObject({
      kind: 'backend_unavailable',
    });
  });

  it('maps an invalid audio rejection to malformed_audio', async () => {
    const transport = new InMemoryTransport().on({
      method: 'POST',
      path: ARIA_ENDPOINTS.stt,
      status: 400,
      body: { contract_version: 1, code: 'invalid_request', message: 'bad audio' },
    });
    await expect(proxy(transport).transcribe({ audio: AUDIO })).rejects.toMatchObject({
      kind: 'malformed_audio',
    });
  });
});

describe('BackendSpeechProxy synthesis contract', () => {
  it('submits the Aria /v1/tts request and returns the audio payload', async () => {
    const transport = new InMemoryTransport().on({
      method: 'POST',
      path: ARIA_ENDPOINTS.tts,
      status: 200,
      body: { contract_version: 1, audio: AUDIO },
    });
    const audio = await proxy(transport).synthesize({ text: 'hi', voice: 'v1', sampleRate: 16_000 });
    expect(audio.samples_le_base64).toBe(AUDIO.samples_le_base64);
    const call = transport.recorded()[0];
    expect(call?.body).toMatchObject({
      contract_version: 1,
      text: 'hi',
      voice: 'v1',
      sample_rate: 16_000,
    });
  });

  it('surfaces a synthesis provider failure as a VoiceError', async () => {
    const transport = new InMemoryTransport().on({
      method: 'POST',
      path: ARIA_ENDPOINTS.tts,
      status: 502,
      body: { contract_version: 1, code: 'upstream_unavailable', message: 'tts down' },
    });
    await expect(proxy(transport).synthesize({ text: 'hi' })).rejects.toBeInstanceOf(VoiceError);
  });
});

describe('BackendSpeechProxy capabilities', () => {
  it('reads the capability advertisement without a token', async () => {
    const transport = new InMemoryTransport().on({
      method: 'GET',
      path: ARIA_ENDPOINTS.capabilities,
      status: 200,
      body: {
        contract_version: 1,
        backend_version: 'test/1',
        stt_languages: ['en'],
        tts_languages: ['en'],
        voices: [{ id: 'v1', name: 'Voice One', language: 'en' }],
        streaming_stt: true,
        streaming_chat: true,
        streaming_tts: false,
      },
    });
    const caps = await proxy(transport).capabilities();
    expect(caps.voices[0]?.id).toBe('v1');
    expect(caps.streamingStt).toBe(true);
    expect(caps.outputControls).toBeUndefined();
  });

  it('reads the advertised output controls when the Backend offers them', async () => {
    const transport = new InMemoryTransport().on({
      method: 'GET',
      path: ARIA_ENDPOINTS.capabilities,
      status: 200,
      body: {
        contract_version: 1,
        backend_version: 'test/1',
        stt_languages: ['en'],
        tts_languages: ['en'],
        voices: [{ id: 'v1', name: 'Voice One', language: 'en' }],
        streaming_stt: true,
        streaming_chat: true,
        streaming_tts: false,
        output_controls: { pitch: true, volume: false, styles: true },
      },
    });
    const caps = await proxy(transport).capabilities();
    expect(caps.outputControls).toEqual({ pitch: true, volume: false, styles: true });
  });
});

describe('BackendSpeechProxy output controls', () => {
  it('sends pitch/volume/style only when the caller supplies them', async () => {
    const transport = new InMemoryTransport().on({
      method: 'POST',
      path: ARIA_ENDPOINTS.tts,
      status: 200,
      body: {
        contract_version: 1,
        audio: { sample_rate: 16_000, channels: 1, samples_le_base64: 'AA==' },
      },
    });
    await proxy(transport).synthesize({
      text: 'hi',
      pitch: 1.1,
      volume: 0.8,
      style: 'warm',
    });
    expect(transport.recorded()[0]?.body).toMatchObject({
      text: 'hi',
      pitch: 1.1,
      volume: 0.8,
      style: 'warm',
    });
  });
});

describe('voiceErrorFromBackend', () => {
  it('treats an uncertain timeout as reconcile, not a definite failure', () => {
    const error = voiceErrorFromBackend(ariaError('timeout', 'timed out'));
    expect(error.kind).toBe('timeout');
    expect(error.recovery).toBe('reconcile');
  });
});

describe('BackendSpeechProxy streaming', () => {
  async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const item of gen) out.push(item);
    return out;
  }

  it('reads a streaming transcript, yielding partials and the final text', async () => {
    const transport = new InMemoryTransport().onStream({
      method: 'POST',
      path: ARIA_ENDPOINTS.sttStream,
      status: 200,
      lines: [
        '{"contract_version":1,"is_final":false,"text":"hello","language":"en-US"}',
        '{"contract_version":1,"is_final":false,"text":"hello world","language":"en-US"}',
        '{"contract_version":1,"is_final":true,"text":"hello world","language":"en-US"}',
      ],
    });
    const chunks = await collect(proxy(transport).transcribeStream({ audio: AUDIO }));
    expect(chunks.map((c) => c.text)).toEqual(['hello', 'hello world', 'hello world']);
    expect(chunks.at(-1)?.final).toBe(true);
    expect(transport.recorded()[0]?.path).toBe('/v1/stt/stream');
  });

  it('yields only audio-bearing chunks from a streaming synthesis', async () => {
    const transport = new InMemoryTransport().onStream({
      method: 'POST',
      path: ARIA_ENDPOINTS.ttsStream,
      status: 200,
      lines: [
        '{"contract_version":1,"sequence":0,"is_final":false,"audio":{"sample_rate":16000,"channels":1,"samples_le_base64":"AQACAAMABAA="}}',
        '{"contract_version":1,"sequence":1,"is_final":false,"audio":{"sample_rate":16000,"channels":1,"samples_le_base64":"AQACAAMABAA="}}',
        '{"contract_version":1,"sequence":2,"is_final":true,"audio":{"sample_rate":16000,"channels":1,"samples_le_base64":""}}',
      ],
    });
    const chunks = await collect(proxy(transport).synthesizeStream({ text: 'hi' }));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.samples_le_base64).toBe('AQACAAMABAA=');
  });

  it('maps a rejected transcription stream onto the voice taxonomy', async () => {
    const transport = new InMemoryTransport().onStream({
      method: 'POST',
      path: ARIA_ENDPOINTS.sttStream,
      status: 401,
      lines: [],
    });
    await expect(collect(proxy(transport).transcribeStream({ audio: AUDIO }))).rejects.toMatchObject({
      kind: 'not_signed_in',
    });
  });
});
