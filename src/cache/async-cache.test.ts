import { describe, expect, it, vi } from 'vitest';

import { AsyncCache } from './async-cache.js';

describe('AsyncCache', () => {
  it('serves a fresh value without calling the producer again', async () => {
    const cache = new AsyncCache<number>({ ttlMs: 1000 });
    const producer = vi.fn(async () => 1);
    expect(await cache.get('k', producer)).toBe(1);
    expect(await cache.get('k', producer)).toBe(1);
    expect(producer).toHaveBeenCalledTimes(1);
  });

  it('re-fetches once the entry expires', async () => {
    let clock = 0;
    const cache = new AsyncCache<number>({ ttlMs: 1000, now: () => clock });
    const producer = vi.fn(async () => clock);
    expect(await cache.get('k', producer)).toBe(0);
    clock = 999;
    expect(await cache.get('k', producer)).toBe(0);
    clock = 1000;
    expect(await cache.get('k', producer)).toBe(1000);
    expect(producer).toHaveBeenCalledTimes(2);
  });

  it('de-duplicates concurrent misses into a single producer call', async () => {
    const cache = new AsyncCache<string>({ ttlMs: 1000 });
    let resolve!: (value: string) => void;
    const producer = vi.fn(
      () =>
        new Promise<string>((r) => {
          resolve = r;
        }),
    );
    const first = cache.get('k', producer);
    const second = cache.get('k', producer);
    expect(producer).toHaveBeenCalledTimes(1);
    resolve('done');
    expect(await first).toBe('done');
    expect(await second).toBe('done');
  });

  it('does not cache a producer failure', async () => {
    const cache = new AsyncCache<number>({ ttlMs: 1000 });
    const producer = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(7);
    await expect(cache.get('k', producer)).rejects.toThrow('boom');
    expect(await cache.get('k', producer)).toBe(7);
    expect(producer).toHaveBeenCalledTimes(2);
  });

  it('honours shouldCache to skip storing a resolved value', async () => {
    const cache = new AsyncCache<{ ok: boolean }>({
      ttlMs: 1000,
      shouldCache: (value) => value.ok,
    });
    const producer = vi.fn(async () => ({ ok: false }));
    await cache.get('k', producer);
    await cache.get('k', producer);
    expect(producer).toHaveBeenCalledTimes(2);
  });

  it('invalidate and clear force a re-fetch', async () => {
    const cache = new AsyncCache<number>({ ttlMs: 1000 });
    const producer = vi.fn(async () => 1);
    await cache.get('k', producer);
    cache.invalidate('k');
    await cache.get('k', producer);
    cache.clear();
    await cache.get('k', producer);
    expect(producer).toHaveBeenCalledTimes(3);
  });

  it('peek returns undefined for an expired entry and prunes it', async () => {
    let clock = 0;
    const cache = new AsyncCache<number>({ ttlMs: 10, now: () => clock });
    await cache.get('k', async () => 1);
    expect(cache.peek('k')).toBe(1);
    clock = 10;
    expect(cache.peek('k')).toBeUndefined();
    expect(cache.size()).toBe(0);
  });
});
