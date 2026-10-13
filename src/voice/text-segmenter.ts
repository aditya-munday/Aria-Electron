/**
 * Segmenting a streaming chat response into speakable sentences.
 *
 * The perceived latency of a spoken reply is dominated by how long it takes to
 * start speaking, not by how long the whole reply takes to arrive. This turns
 * the incremental chat deltas into the earliest natural break that is long
 * enough to be worth synthesizing, so TTS can begin on the first sentence while
 * the rest of the response is still streaming.
 *
 * A break is a sentence terminator (`.`, `!`, `?`, `;`, `:`) that is followed by
 * whitespace or the end of the buffer, so a decimal (`3.14`) or an abbreviation
 * without a following space (`e.g.`) is never cut mid-token. The first segment
 * is released at the smaller threshold; later segments wait for the larger one,
 * which keeps the number of synthesis requests down once speech has started.
 */

export interface TextSegmenterOptions {
  /** Minimum length of the first segment, in characters. */
  readonly minFirstChars?: number;
  /** Minimum length of every later segment, in characters. */
  readonly minChunkChars?: number;
}

export const DEFAULT_MIN_FIRST_CHARS = 12;
export const DEFAULT_MIN_CHUNK_CHARS = 40;

const TERMINATORS = '.!?;:';
const WHITESPACE = /\s/;

export class TextSegmenter {
  private buffer = '';
  private emittedFirst = false;
  private readonly minFirst: number;
  private readonly minChunk: number;

  constructor(options: TextSegmenterOptions = {}) {
    this.minFirst = options.minFirstChars ?? DEFAULT_MIN_FIRST_CHARS;
    this.minChunk = options.minChunkChars ?? DEFAULT_MIN_CHUNK_CHARS;
  }

  /** Append a delta and return every complete segment it completed. */
  push(delta: string): string[] {
    if (delta === '') return [];
    this.buffer += delta;
    const segments: string[] = [];
    for (;;) {
      const end = this.findBreak();
      if (end < 0) break;
      const segment = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end);
      if (segment === '') continue;
      this.emittedFirst = true;
      segments.push(segment);
    }
    return segments;
  }

  /** Release whatever remains (the response ended). */
  flush(): string[] {
    const tail = this.buffer.trim();
    this.buffer = '';
    return tail === '' ? [] : [tail];
  }

  private findBreak(): number {
    const min = this.emittedFirst ? this.minChunk : this.minFirst;
    for (let i = 0; i < this.buffer.length; i += 1) {
      const ch = this.buffer[i] as string;
      if (!TERMINATORS.includes(ch)) continue;
      const before = this.buffer[i - 1];
      const after = this.buffer[i + 1];
      if (isDigit(before) && (after === undefined || isDigit(after))) {
        continue;
      }
      // A terminator is only a boundary when the next character is whitespace or
      // the delta ended here; otherwise it is mid-token (an abbreviation or a
      // version number) and the break must wait for more text.
      if (after !== undefined && !WHITESPACE.test(after)) continue;
      if (after === undefined && ch !== '.' && ch !== '!' && ch !== '?') continue;
      if (this.buffer.slice(0, i + 1).trim().length < min) continue;
      return i + 1;
    }
    return -1;
  }
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}
