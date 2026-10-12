import { describe, expect, it } from 'vitest';

import { AriaClient, AriaStreamError } from './aria-client.js';
import { InMemoryTransport, NoToken, SharedToken } from './transport.js';

function client(t: InMemoryTransport, tokens = new SharedToken('tok')): AriaClient {
  return new AriaClient({ transport: t, tokens });
}

const CAPABILITIES = {
  contract_version: 1,
  backend_version: '2026.10.0',
  stt_languages: ['en-US'],
  tts_languages: ['en-US'],
  voices: [{ id: 'v1', name: 'One', language: 'en-US', accent: { tag: 'en-us' } }],
  streaming_stt: true,
  streaming_chat: true,
  streaming_tts: false,
};

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

describe('AriaClient unary routes', () => {
  it('reads capabilities without a token', async () => {
    const t = new InMemoryTransport().on({
      method: 'GET',
      path: '/v1/capabilities',
      status: 200,
      body: CAPABILITIES,
    });
    const result = await client(t, new NoToken()).capabilities();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.backend_version).toBe('2026.10.0');
  });

  it('surfaces the output controls the Backend advertises', async () => {
    const t = new InMemoryTransport().on({
      method: 'GET',
      path: '/v1/capabilities',
      status: 200,
      body: { ...CAPABILITIES, output_controls: { pitch: true, volume: false, styles: true } },
    });
    const result = await client(t).capabilities();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.output_controls).toEqual({ pitch: true, volume: false, styles: true });
  });

  it('leaves output controls absent when the Backend does not advertise them', async () => {
    const t = new InMemoryTransport().on({
      method: 'GET',
      path: '/v1/capabilities',
      status: 200,
      body: CAPABILITIES,
    });
    const result = await client(t).capabilities();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.output_controls).toBeUndefined();
  });

  it('rejects a mismatched contract_version as malformed, never a downgrade', async () => {
    const t = new InMemoryTransport().on({
      method: 'GET',
      path: '/v1/capabilities',
      status: 200,
      body: { ...CAPABILITIES, contract_version: 2 },
    });
    const result = await client(t).capabilities();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('malformed');
  });

  it('returns chat text and an advisory route hint', async () => {
    const t = new InMemoryTransport().on({
      method: 'POST',
      path: '/v1/chat',
      status: 200,
      body: {
        contract_version: 1,
        text: 'I can do that.',
        route: { capability: 'network.configure', requires_confirmation: true },
      },
    });
    const result = await client(t).chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.route?.requires_confirmation).toBe(true);
    // The route hint is not an authorization: it is just surfaced.
    expect(t.recorded()[0]?.body).toMatchObject({ contract_version: 1 });
  });

  it('requires a token for a protected route', async () => {
    const t = new InMemoryTransport();
    const result = await client(t, new NoToken()).chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('no_token');
  });

  it('maps a flat Aria error body onto a classified error', async () => {
    const t = new InMemoryTransport().on({
      method: 'POST',
      path: '/v1/tts',
      status: 403,
      body: { contract_version: 1, code: 'forbidden', message: 'no entitlement' },
    });
    const result = await client(t).tts({ text: 'hello' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('forbidden');
    expect(result.error.message).toBe('no entitlement');
  });
});

describe('AriaClient chat stream', () => {
  it('yields incremental deltas and stops at the final event', async () => {
    const t = new InMemoryTransport().onStream({
      method: 'POST',
      path: '/v1/chat/stream',
      status: 200,
      lines: [
        '{"contract_version":1,"is_final":false,"delta":"I am ","route":null}',
        '{"contract_version":1,"is_final":false,"delta":"well.","route":null}',
        '{"contract_version":1,"is_final":true,"delta":"","route":null}',
      ],
    });
    const events = await collect(client(t).chatStream({ messages: [{ role: 'user', content: 'hi' }] }));
    expect(events.map((e) => e.delta)).toEqual(['I am ', 'well.', '']);
    expect(events.at(-1)?.is_final).toBe(true);
  });

  it('throws a stream error on a malformed line', async () => {
    const t = new InMemoryTransport().onStream({
      method: 'POST',
      path: '/v1/chat/stream',
      status: 200,
      lines: ['not json'],
    });
    await expect(
      collect(client(t).chatStream({ messages: [{ role: 'user', content: 'hi' }] })),
    ).rejects.toBeInstanceOf(AriaStreamError);
  });

  it('throws a stream error when the stream is rejected', async () => {
    const t = new InMemoryTransport().onStream({
      method: 'POST',
      path: '/v1/chat/stream',
      status: 503,
      lines: [],
    });
    await expect(
      collect(client(t).chatStream({ messages: [{ role: 'user', content: 'hi' }] })),
    ).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('refuses to stream without a token', async () => {
    const t = new InMemoryTransport();
    await expect(
      collect(
        client(t, new NoToken()).chatStream({ messages: [{ role: 'user', content: 'hi' }] }),
      ),
    ).rejects.toMatchObject({ kind: 'no_token' });
  });
});

describe('AriaClient stt/tts streams', () => {
  it('reads a streaming transcript (text is the transcript so far)', async () => {
    const t = new InMemoryTransport().onStream({
      method: 'POST',
      path: '/v1/stt/stream',
      status: 200,
      lines: [
        '{"contract_version":1,"is_final":false,"text":"hel"}',
        '{"contract_version":1,"is_final":false,"text":"hello"}',
        '{"contract_version":1,"is_final":true,"text":"hello"}',
      ],
    });
    const events = await collect(
      client(t).sttStream({
        audio: { sample_rate: 16000, channels: 1, samples_le_base64: '' },
      }),
    );
    expect(events.map((e) => e.text)).toEqual(['hel', 'hello', 'hello']);
  });

  it('reads synthesis chunks with a contiguous sequence', async () => {
    const t = new InMemoryTransport().onStream({
      method: 'POST',
      path: '/v1/tts/stream',
      status: 200,
      lines: [
        '{"contract_version":1,"sequence":0,"is_final":false,"audio":{"sample_rate":16000,"channels":1,"samples_le_base64":"AA=="}}',
        '{"contract_version":1,"sequence":1,"is_final":true,"audio":{"sample_rate":16000,"channels":1,"samples_le_base64":""}}',
      ],
    });
    const events = await collect(client(t).ttsStream({ text: 'hi' }));
    expect(events.map((e) => e.sequence)).toEqual([0, 1]);
  });

  it('forwards output controls on the synthesis stream', async () => {
    const t = new InMemoryTransport().onStream({
      method: 'POST',
      path: '/v1/tts/stream',
      status: 200,
      lines: [
        '{"contract_version":1,"sequence":0,"is_final":true,"audio":{"sample_rate":16000,"channels":1,"samples_le_base64":"AA=="}}',
      ],
    });
    await collect(
      client(t).ttsStream({ text: 'hi', pitch: 1.2, volume: 0.8, style: 'warm' }),
    );
    expect(t.recorded()[0]?.body).toMatchObject({ pitch: 1.2, volume: 0.8, style: 'warm' });
  });
});
