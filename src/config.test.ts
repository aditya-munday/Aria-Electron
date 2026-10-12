import { describe, expect, it } from 'vitest';

import { loadConfig, loadSessionToken, normalizeBaseUrl } from './config.js';

describe('loadConfig', () => {
  it('defaults to the Beyonders backend when the environment is empty', () => {
    const config = loadConfig({} as NodeJS.ProcessEnv);
    expect(config.backendBaseUrl).toBe('https://api.adityamunday.codes');
    expect(config.requestTimeoutMs).toBe(30_000);
    expect(config.model.provider).toBe('groq');
    expect(config.model.id).toBe('groq/llama-3.3-70b-versatile');
  });

  it('reads the backend URL and timeout from the environment', () => {
    const config = loadConfig({
      ARIA_BACKEND_URL: 'https://api.example.test/',
      ARIA_REQUEST_TIMEOUT_MS: '5000',
    } as NodeJS.ProcessEnv);
    expect(config.backendBaseUrl).toBe('https://api.example.test');
    expect(config.requestTimeoutMs).toBe(5000);
  });

  it('falls back to the default timeout for a non-numeric value', () => {
    const config = loadConfig({
      ARIA_REQUEST_TIMEOUT_MS: 'soon',
    } as NodeJS.ProcessEnv);
    expect(config.requestTimeoutMs).toBe(30_000);
  });

  it('loads a session token only when it is non-empty', () => {
    expect(loadSessionToken({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(loadSessionToken({ ARIA_SESSION_TOKEN: '   ' } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(loadSessionToken({ ARIA_SESSION_TOKEN: 'tok-123' } as NodeJS.ProcessEnv)).toBe('tok-123');
  });
});

describe('normalizeBaseUrl', () => {
  it('trims a trailing slash', () => {
    expect(normalizeBaseUrl('https://example.test/')).toBe('https://example.test');
  });

  it('rejects a non-http protocol', () => {
    expect(() => normalizeBaseUrl('ftp://example.test')).toThrow(/Unsupported backend protocol/);
  });

  it('rejects a URL with embedded credentials', () => {
    expect(() => normalizeBaseUrl('https://user:pass@example.test')).toThrow(
      /must not embed credentials/,
    );
  });
});
