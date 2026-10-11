/**
 * A bounded ring buffer for float audio frames.
 *
 * The capture path pushes frames as they arrive; a consumer (VAD, the utterance
 * assembler) reads them. The buffer has a hard capacity: when it is full the
 * **oldest** samples are dropped, so a slow consumer or a burst of frames can
 * never grow memory without limit or block the capture callback.
 *
 * This is a bounded queue, not a channel with backpressure, because dropping
 * the oldest audio is the correct degradation for a live microphone: stale audio
 * is worthless, and blocking the capture thread deadlocks the audio device.
 */

export interface RingBufferStats {
  readonly capacity: number;
  readonly length: number;
  /** Samples dropped because the buffer was full. */
  readonly dropped: number;
}

export class AudioRingBuffer {
  private readonly data: Float64Array;
  private readonly capacity: number;
  private head = 0;
  private count = 0;
  private droppedSamples = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError('Ring buffer capacity must be a positive integer.');
    }
    this.capacity = capacity;
    this.data = new Float64Array(capacity);
  }

  /** The number of samples currently buffered. */
  get length(): number {
    return this.count;
  }

  get stats(): RingBufferStats {
    return { capacity: this.capacity, length: this.count, dropped: this.droppedSamples };
  }

  /** Push one sample, overwriting the oldest sample when full. */
  push(sample: number): void {
    const index = (this.head + this.count) % this.capacity;
    this.data[index] = sample;
    if (this.count < this.capacity) {
      this.count += 1;
    } else {
      this.head = (this.head + 1) % this.capacity;
      this.droppedSamples += 1;
    }
  }

  /** Push a frame of samples. */
  pushAll(samples: ArrayLike<number>): void {
    for (let i = 0; i < samples.length; i += 1) {
      this.push(samples[i] as number);
    }
  }

  /**
   * Drain up to `max` of the oldest samples into a new array and remove them.
   * Returns fewer than `max` when the buffer holds fewer.
   */
  drain(max: number): Float64Array {
    const take = Math.min(max, this.count);
    const out = new Float64Array(take);
    for (let i = 0; i < take; i += 1) {
      out[i] = this.data[(this.head + i) % this.capacity] as number;
    }
    this.head = (this.head + take) % this.capacity;
    this.count -= take;
    return out;
  }

  /** Drain every buffered sample. */
  drainAll(): Float64Array {
    return this.drain(this.count);
  }

  /** Read without removing: the sample at `offset` from the oldest. */
  peek(offset: number): number | undefined {
    if (offset < 0 || offset >= this.count) return undefined;
    return this.data[(this.head + offset) % this.capacity] as number;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }
}
