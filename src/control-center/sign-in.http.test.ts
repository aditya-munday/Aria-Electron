import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { AriaRuntime } from '../runtime.js';
import { verifySignIn } from './sign-in.js';

const GOOD_TOKEN = 'session-good';
const IDENTITY = {
  userId: 'user-42',
  email: 'ada@example.com',
  roles: ['member'],
  providers: ['github'],
  anonymous: false,
};

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve(text === '' ? undefined : JSON.parse(text));
    });
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url === '/api/v1/me') {
      const auth = req.headers.authorization ?? '';
      if (auth === `Bearer ${GOOD_TOKEN}`) {
        json(res, 200, { identity: IDENTITY });
        return;
      }
      json(res, 401, { error: { code: 'unauthenticated', message: 'Invalid session token.' } });
      return;
    }
    if (url === '/v1/capabilities') {
      json(res, 200, { voices: [] });
      return;
    }
    json(res, 404, { error: { code: 'not_found', message: 'No such route.' } });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error !== undefined && error !== null ? reject(error) : resolve())),
  );
});

function runtime(): AriaRuntime {
  return new AriaRuntime({
    config: { backendBaseUrl: baseUrl, requestTimeoutMs: 2000, model: { provider: 'groq', id: 'groq/llama-3.3-70b-versatile', displayName: 'Llama 3.3 70B (Groq)' } },
    store: undefined,
  });
}

function accountFor(rt: AriaRuntime) {
  return {
    sessionToken: rt.sessionToken(),
    setSessionToken: (token: string | undefined) => rt.setSessionToken(token),
    identity: () => rt.identity(),
  };
}

describe('verifySignIn over a real HTTP transport', () => {
  it('accepts a token the Backend resolves and reports the real identity', async () => {
    const rt = runtime();
    const result = await verifySignIn({ token: GOOD_TOKEN }, accountFor(rt));
    expect(result).toEqual({ ok: true, signedIn: true, reason: 'Signed in as user-42.' });
    expect(rt.isSignedIn()).toBe(true);
  });

  it('rejects a token the Backend refuses and leaves the shell signed out', async () => {
    const rt = runtime();
    const result = await verifySignIn({ token: 'session-bad' }, accountFor(rt));
    expect(result).toMatchObject({ ok: false, signedIn: false, recovery: 'authenticate' });
    expect(rt.isSignedIn()).toBe(false);
  });

  it('keeps the previous session when a new token is refused', async () => {
    const rt = runtime();
    await verifySignIn({ token: GOOD_TOKEN }, accountFor(rt));
    const result = await verifySignIn({ token: 'session-bad' }, accountFor(rt));
    expect(result.ok).toBe(false);
    expect(rt.sessionToken()).toBe(GOOD_TOKEN);
    expect(rt.isSignedIn()).toBe(true);
  });
});
