export interface AriaModel {
  readonly provider: 'groq';
  readonly id: string;
  readonly displayName: string;
}

export const ARIA_MODEL: AriaModel = {
  provider: 'groq',
  id: 'groq/llama-3.3-70b-versatile',
  displayName: 'Llama 3.3 70B (Groq)',
};

export interface AriaConfig {
  readonly backendBaseUrl: string;
  /** Origin serving the device-code sign-in flow; defaults to the Aria backend. */
  readonly loginBaseUrl?: string;
  readonly requestTimeoutMs: number;
  readonly model: AriaModel;
}

const DEFAULT_BACKEND_BASE_URL = 'https://api.adityamunday.codes';
// The device-code endpoints (`/api/auth/cli/*`) are part of the backend, not the
// marketing site: the website's own `/cli/login` page relays approvals to this
// same origin. They share a host today, but they are distinct surfaces.
const DEFAULT_LOGIN_BASE_URL = 'https://api.adityamunday.codes';
const DEFAULT_TIMEOUT_MS = 30_000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AriaConfig {
  const raw = env['ARIA_BACKEND_URL']?.trim();
  const loginRaw = env['ARIA_LOGIN_URL']?.trim();
  const timeoutRaw = env['ARIA_REQUEST_TIMEOUT_MS']?.trim();
  const timeout = timeoutRaw !== undefined ? Number.parseInt(timeoutRaw, 10) : NaN;

  return {
    backendBaseUrl: normalizeBaseUrl(
      raw !== undefined && raw !== '' ? raw : DEFAULT_BACKEND_BASE_URL,
    ),
    loginBaseUrl: normalizeBaseUrl(
      loginRaw !== undefined && loginRaw !== '' ? loginRaw : DEFAULT_LOGIN_BASE_URL,
    ),
    requestTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
    model: ARIA_MODEL,
  };
}

export function loadSessionToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env['ARIA_SESSION_TOKEN']?.trim();
  return raw !== undefined && raw !== '' ? raw : undefined;
}

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
