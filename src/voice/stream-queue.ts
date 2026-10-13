/**
 * A push-based async queue.
 *
 * The speech pipeline produces PCM chunks from several sentence syntheses that
 * run at different times, but they must reach the output device as one
 * continuous, in-order stream. An async iterable fed by `push` gives the device
 * a single sequence to drain: the consumer awaits the next item, and `close`
 * ends it. This is what lets playback start on the first chunk while later
 * sentences are still being synthesized.
 */

export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiter: (() => void) | undefined;
  private closed = false;
  private failure: unknown;

  /** Append an item. Ignored once the queue is closed. */
  push(item: T): void {
    if (this.closed) return;
    this.items.push(item);
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.();
  }

  /** End the stream cleanly; a pending consumer sees `done`. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.();
  }

  /** End the stream with an error; a pending consumer throws it. */
  fail(error: unknown): void {
    if (this.closed) return;
    this.failure = error;
    this.close();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.items.length > 0) {
        yield this.items.shift() as T;
        continue;
      }
      if (this.failure !== undefined) throw this.failure;
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}
