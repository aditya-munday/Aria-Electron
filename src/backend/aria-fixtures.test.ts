import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AriaClient } from './aria-client.js';
import { InMemoryTransport, SharedToken } from './transport.js';

/**
 * Golden-fixture tests: Aria-Electron must parse the Backend's canonical `/v1`
 * fixtures verbatim. The fixtures are vendored from the Backend's
 * `contracts/aria/` so a drift in either direction fails loudly here.
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', '..', 'fixtures', 'aria');

function lines(name: string): string[] {
  return readFileSync(join(fixtures, name), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtures, name), 'utf8')) as unknown;
}

function client(t: InMemoryTransport): AriaClient {
  return new AriaClient({ transport: t, tokens: new SharedToken('tok') });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

describe('canonical Aria fixtures', () => {
  it('parses the canonical capabilities response', async () => {
    const t = new InMemoryTransport().on({
      method: 'GET',
      path: '/v1/capabilities',
      status: 200,
      body: readJson('v1-capabilities.response.json'),
    });
    const result = await client(t).capabilities();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.contract_version).toBe(1);
    expect(result.value.voices.length).toBeGreaterThan(0);
  });

  it('parses the canonical chat stream', async () => {
    const t = new InMemoryTransport().onStream({
      method: 'POST',
      path: '/v1/chat/stream',
      status: 200,
      lines: lines('v1-chat-stream.ndjson'),
    });
    const events = await collect(client(t).chatStream({ messages: [{ role: 'user', content: 'hi' }] }));
    expect(events.at(-1)?.is_final).toBe(true);
  });

  it('parses the canonical stt stream', async () => {
    const t = new InMemoryTransport().onStream({
      method: 'POST',
      path: '/v1/stt/stream',
      status: 200,
      lines: lines('v1-stt-stream.ndjson'),
    });
    const events = await collect(
      client(t).sttStream({ audio: { sample_rate: 16000, channels: 1, samples_le_base64: '' } }),
    );
    expect(events.at(-1)?.text).toBe('hello world');
    expect(events.at(-1)?.is_final).toBe(true);
  });

  it('parses the canonical tts stream', async () => {
    const t = new InMemoryTransport().onStream({
      method: 'POST',
      path: '/v1/tts/stream',
      status: 200,
      lines: lines('v1-tts-stream.ndjson'),
    });
    const events = await collect(client(t).ttsStream({ text: 'hello world' }));
    expect(events.map((e) => e.sequence)).toEqual([0, 1, 2]);
    expect(events.at(-1)?.is_final).toBe(true);
  });

  it('reads the canonical error body', async () => {
    const t = new InMemoryTransport().on({
      method: 'POST',
      path: '/v1/chat',
      status: 403,
      body: readJson('v1-error.response.json'),
    });
    const result = await client(t).chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe('no entitlement');
  });
});
