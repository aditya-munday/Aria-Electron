import { describe, expect, it } from 'vitest';

import { readNdjson } from './ndjson.js';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of readNdjson(body)) out.push(line);
  return out;
}

describe('readNdjson', () => {
  it('splits complete lines', async () => {
    expect(await collect(streamOf(['a\nb\nc\n']))).toEqual(['a', 'b', 'c']);
  });

  it('reassembles a line split across a chunk boundary', async () => {
    expect(await collect(streamOf(['{"del', 'ta":"hi"}\n']))).toEqual(['{"delta":"hi"}']);
  });

  it('yields a final line that has no trailing newline', async () => {
    expect(await collect(streamOf(['a\nb']))).toEqual(['a', 'b']);
  });

  it('handles a multi-byte character split across chunks', async () => {
    // The emoji is four bytes; split it in the middle.
    const encoded = new TextEncoder().encode('x\n\u{1F600}\n');
    const first = encoded.slice(0, 3);
    const second = encoded.slice(3);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(first);
        controller.enqueue(second);
        controller.close();
      },
    });
    expect(await collect(body)).toEqual(['x', '\u{1F600}']);
  });
});
