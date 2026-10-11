/**
 * Runtime configuration for the Aria desktop client.
 *
 * Configuration is read from the environment for development and can be
 * overridden by the app's settings. It never holds a secret: Aria carries only
 * a short-lived user session token, which is acquired through sign-in and kept
 * in memory, never written to disk.
 */

export interface AriaConfig {
  /** Base URL of the Directioner Platform Backend (product surface `/api/v1`). */
  readonly backendBaseUrl: string;
  /** Request timeout for a single backend call. */
  readonly requestTimeoutMs: number;
}

const DEFAULT_BACKEND_BASE_URL = 'http://127.0.0.1:8080';
const DEFAULT_TIMEOUT_MS = 30_000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AriaConfig {
  const raw = env['DIRECTIONER_BACKEND_URL']?.trim();
  const timeoutRaw = env['DIRECTIONER_REQUEST_TIMEOUT_MS']?.trim();
  const timeout = timeoutRaw !== undefined ? Number.parseInt(timeoutRaw, 10) : NaN;

  return {
    backendBaseUrl: normalizeBaseUrl(raw !== undefined && raw !== '' ? raw : DEFAULT_BACKEND_BASE_URL),
    requestTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
  };
}

/**
 * Normalize and validate the base URL. A base URL must be `http(s)` and must not
 * carry a query, fragment, or embedded credentials; a URL with userinfo is
 * rejected rather than silently sending a password.
 */
export function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  const parsed = new URL(trimmed);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported backend protocol: ${parsed.protocol}`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('Backend URL must not embed credentials.');
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}
