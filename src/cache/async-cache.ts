/**
 * A small TTL cache with single-flight de-duplication.
 *
 * Two behaviours, both aimed at the same problem — a slow backend making the
 * UI feel laggy:
 *
 *   - **TTL**: a value read within its lifetime is served from memory instead
 *     of hitting the network again. This is what stops every renderer refresh
 *     from re-fetching capabilities, identity and the task list.
 *   - **Single-flight**: concurrent misses for the same key share one in-flight
 *     request rather than each launching their own. Ten renderers asking for
 *     capabilities at once produce one backend call, not ten.
 *
 * Only *successful* results are cached; a failure is returned to its caller but
 * never stored, so a transient outage is retried rather than pinned.
 *
 * Time is injected (`now`) so expiry and de-duplication are deterministic in
 * tests instead of depending on a real clock.
 */

export interface AsyncCacheOptions<T> {
  /** How long a value stays fresh, in milliseconds. */
  readonly ttlMs: number;
  /** Injectable clock, for deterministic tests. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Whether a resolved value may be stored. Defaults to caching everything. */
  readonly shouldCache?: (value: T) => boolean;
}

interface Entry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

export class AsyncCache<T> {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly shouldCache: (value: T) => boolean;
  private readonly entries = new Map<string, Entry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(options: AsyncCacheOptions<T>) {
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
    this.shouldCache = options.shouldCache ?? (() => true);
  }

  /** The cached value for `key`, or `undefined` when absent or expired. */
  peek(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /**
   * Return the fresh value for `key`, otherwise run `producer` once. Concurrent
   * callers for the same key await the same promise. A producer failure is
   * propagated and not cached.
   */
  async get(key: string, producer: () => Promise<T>): Promise<T> {
    const cached = this.peek(key);
    if (cached !== undefined) return cached;
    const pending = this.inflight.get(key);
    if (pending !== undefined) return pending;
    const promise = producer().then(
      (value) => {
        if (this.shouldCache(value)) {
          this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
        }
        this.inflight.delete(key);
        return value;
      },
      (error: unknown) => {
        this.inflight.delete(key);
        throw error;
      },
    );
    this.inflight.set(key, promise);
    return promise;
  }

  /** Drop one key, forcing the next `get` to re-fetch. */
  invalidate(key: string): void {
    this.entries.delete(key);
  }

  /** Drop every key. */
  clear(): void {
    this.entries.clear();
  }

  /** The number of fresh entries (diagnostics/tests). */
  size(): number {
    for (const key of [...this.entries.keys()]) this.peek(key);
    return this.entries.size;
  }
}
