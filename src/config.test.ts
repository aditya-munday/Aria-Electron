import { describe, expect, it } from 'vitest';

import { loadConfig, normalizeBaseUrl } from './config.js';

describe('loadConfig', () => {
  it('uses local defaults when the environment is empty', () => {
    const config = loadConfig({} as NodeJS.ProcessEnv);
    expect(config.backendBaseUrl).toBe('http://127.0.0.1:8080');
    expect(config.requestTimeoutMs).toBe(30_000);
  });

  it('reads the backend URL and timeout from the environment', () => {
    const config = loadConfig({
      DIRECTIONER_BACKEND_URL: 'https://api.directioner.example/',
      DIRECTIONER_REQUEST_TIMEOUT_MS: '5000',
    } as NodeJS.ProcessEnv);
    expect(config.backendBaseUrl).toBe('https://api.directioner.example');
    expect(config.requestTimeoutMs).toBe(5000);
  });

  it('falls back to the default timeout for a non-numeric value', () => {
    const config = loadConfig({
      DIRECTIONER_REQUEST_TIMEOUT_MS: 'soon',
    } as NodeJS.ProcessEnv);
    expect(config.requestTimeoutMs).toBe(30_000);
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
