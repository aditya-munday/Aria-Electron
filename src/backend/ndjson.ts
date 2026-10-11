/**
 * Reading newline-delimited JSON incrementally.
 *
 * Aria's `/v1` streams are NDJSON. A consumer must see each event as it arrives
 * (chat deltas, partial transcripts) rather than waiting for the body to close,
 * and a chunk boundary can fall in the middle of a line, so a partial line is
 * buffered until its newline arrives.
 */

export async function* readNdjson(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        yield buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    // A final line without a trailing newline is still an event.
    if (buffer.trim() !== '') yield buffer;
  } finally {
    reader.releaseLock();
  }
}

/** Yield only the non-empty, trimmed lines of a chunk of NDJSON text. */
export function* splitLines(text: string): Generator<string, void, void> {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') yield trimmed;
  }
}
