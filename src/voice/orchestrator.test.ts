import { describe, expect, it } from 'vitest';

import { AriaClient } from '../backend/aria-client.js';
import { InMemoryTransport } from '../backend/transport.js';
import { ChatOrchestrator } from './orchestrator.js';
import { VoiceError } from './errors.js';

function orchestrator(t: InMemoryTransport): ChatOrchestrator {
  return new ChatOrchestrator({
    client: new AriaClient({ transport: t, tokens: { current: () => 'tok' } }),
  });
}

const SIGNAL = new AbortController().signal;

function lines(events: readonly object[]): string[] {
  return events.map((event) => JSON.stringify(event));
}

describe('ChatOrchestrator streaming', () => {
  it('accumulates the authoritative text from the deltas and forwards each one', async () => {
    const t = new InMemoryTransport().onStream({
      method: 'POST',
      path: '/v1/chat/stream',
      status: 200,
      lines: lines([
        { contract_version: 1, is_final: false, delta: 'Hel' },
        { contract_version: 1, is_final: false, delta: 'lo' },
        { contract_version: 1, is_final: false, delta: ' world' },
        { contract_version: 1, is_final: true, delta: '' },
      ]),
    });
    const deltas: string[] = [];
    const result = await orchestrator(t).respondStream(
      { text: 'greet', sessionId: 's1', signal: SIGNAL },
      (delta) => deltas.push(delta),
    );
    expect(deltas).toEqual(['Hel', 'lo', ' world']);
    expect(result.text).toBe('Hello world');
  });

  it('surfaces a route hint from the stream without treating it as authorization', async () => {
    const t = new InMemoryTransport().onStream({
      method: 'POST',
      path: '/v1/chat/stream',
      status: 200,
      lines: lines([
        { contract_version: 1, is_final: false, delta: 'ok' },
        {
          contract_version: 1,
          is_final: true,
          delta: '',
          route: { capability: 'deploy.service', requires_confirmation: true },
        },
      ]),
    });
    const result = await orchestrator(t).respondStream(
      { text: 'deploy', sessionId: 's1', signal: SIGNAL },
      () => undefined,
    );
    expect(result.route).toEqual({ capability: 'deploy.service', requires_confirmation: true });
  });

  it('throws a backend_unavailable VoiceError when the stream fails', async () => {
    const t = new InMemoryTransport().onStream({
      method: 'POST',
      path: '/v1/chat/stream',
      status: 503,
      lines: [],
    });
    await expect(
      orchestrator(t).respondStream({ text: 'hi', sessionId: 's1', signal: SIGNAL }, () => undefined),
    ).rejects.toBeInstanceOf(VoiceError);
  });
});
