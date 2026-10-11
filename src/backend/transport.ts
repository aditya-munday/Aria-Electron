/**
 * The transport boundary: the only component that touches the network.
 *
 * Everything above it (the task client, the supervisor) is deterministic and
 * testable because a transport can be swapped for an in-memory double. The
 * double is a *real* implementation of the same interface, not a mock of the
 * client under test.
 *
 * A transport carries a bearer token but never a provider key; the token is a
 * short-lived user session token held in memory by the caller.
 */

export interface HttpRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
  readonly token: string;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
  readonly retryAfterSecs?: number;
}

/** A transport-level failure: the request never produced a response. */
export class TransportFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportFailure';
  }
}

export interface Transport {
  request(req: HttpRequest): Promise<HttpResponse>;
}

// ---------------------------------------------------------------------------
// Streaming (Aria's NDJSON `/v1` streams)
// ---------------------------------------------------------------------------

export interface StreamRequest {
  readonly method: 'POST';
  readonly path: string;
  readonly body: unknown;
  readonly token: string;
  /** The accepted media type, e.g. `application/x-ndjson`. */
  readonly accept: string;
  readonly signal?: AbortSignal;
}

export interface StreamResponse {
  readonly status: number;
  /** The raw byte stream, or `null` when the server sent no body. */
  readonly body: ReadableStream<Uint8Array> | null;
}

/**
 * A transport that can also open a streaming response. Aria's chat, STT and TTS
 * streams are newline-delimited JSON, so the client reads them incrementally
 * rather than buffering the whole body.
 */
export interface StreamingTransport extends Transport {
  stream(req: StreamRequest): Promise<StreamResponse>;
}

export interface TokenSource {
  /** The current in-memory session token, or `undefined` when signed out. */
  current(): string | undefined;
}

/** A token source whose value can be set and cleared (sign in / sign out). */
export class SharedToken implements TokenSource {
  private value: string | undefined;

  constructor(initial?: string) {
    this.value = initial;
  }

  set(token: string | undefined): void {
    this.value = token;
  }

  current(): string | undefined {
    return this.value;
  }
}

/** A token source that is always empty, for tests and signed-out states. */
export class NoToken implements TokenSource {
  current(): string | undefined {
    return undefined;
  }
}

export interface FetchTransportOptions {
  readonly baseUrl: string;
  /** Per-request timeout; a hung backend must fail as a transport failure. */
  readonly timeoutMs?: number;
  /** Injectable fetch, for tests and non-global-fetch runtimes. */
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The real HTTPS transport. It performs no privileged operation and defines no
 * remote-shell route; it only opens the task, claims its lease, and reports
 * honest events and results.
 */
export class FetchTransport implements Transport {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;

  constructor(options: FetchTransportOptions) {
    this.base = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.doFetch = options.fetchImpl ?? fetch;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.doFetch(`${this.base}${req.path}`, {
        method: req.method,
        headers: {
          authorization: `Bearer ${req.token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
        signal: controller.signal,
      });
    } catch {
      // A transport failure is an uncertain outcome, never success.
      throw new TransportFailure('Could not reach the Directioner backend.');
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let body: unknown;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    }
    const retryAfterRaw = response.headers.get('retry-after');
    const retryAfterSecs =
      retryAfterRaw !== null && retryAfterRaw.trim() !== ''
        ? Number.parseInt(retryAfterRaw, 10)
        : undefined;
    return {
      status: response.status,
      body,
      ...(retryAfterSecs !== undefined && !Number.isNaN(retryAfterSecs)
        ? { retryAfterSecs }
        : {}),
    };
  }

  /**
   * Open a streaming response. A stream has no request timeout: a long
   * conversation is not a hung request. The caller supplies an abort signal for
   * cancellation (barge-in, window close, emergency stop).
   */
  async stream(req: StreamRequest): Promise<StreamResponse> {
    let response: Response;
    try {
      response = await this.doFetch(`${this.base}${req.path}`, {
        method: req.method,
        headers: {
          authorization: `Bearer ${req.token}`,
          'content-type': 'application/json',
          accept: req.accept,
        },
        body: JSON.stringify(req.body),
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
      });
    } catch {
      throw new TransportFailure('Could not reach the Directioner backend.');
    }
    return { status: response.status, body: response.body };
  }
}

/** One recorded call in an {@link InMemoryTransport}. */
export interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

export interface InMemoryRoute {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly status: number;
  readonly body: unknown;
  readonly retryAfterSecs?: number;
}

/** A scripted streaming route: each entry is one NDJSON line. */
export interface InMemoryStreamRoute {
  readonly method: 'POST';
  readonly path: string;
  readonly status: number;
  readonly lines: readonly string[];
}

/**
 * A deterministic transport for tests. It is a real `Transport` implementation:
 * the client under test runs its real code path against it. Routes may be
 * registered by exact path, and every call is recorded so a test can assert the
 * wire request.
 */
export class InMemoryTransport implements StreamingTransport {
  private readonly routes = new Map<string, InMemoryRoute[]>();
  private readonly streamRoutes = new Map<string, InMemoryStreamRoute[]>();
  private readonly calls: RecordedCall[] = [];
  private transportError: string | undefined;

  private static key(method: string, path: string): string {
    return `${method} ${path}`;
  }

  on(route: InMemoryRoute): this {
    const key = InMemoryTransport.key(route.method, route.path);
    const list = this.routes.get(key) ?? [];
    list.push(route);
    this.routes.set(key, list);
    return this;
  }

  /** Register a scripted NDJSON stream response. */
  onStream(route: InMemoryStreamRoute): this {
    const key = InMemoryTransport.key(route.method, route.path);
    const list = this.streamRoutes.get(key) ?? [];
    list.push(route);
    this.streamRoutes.set(key, list);
    return this;
  }

  /** Make every request fail at the transport layer with `message`. */
  failAll(message: string): this {
    this.transportError = message;
    return this;
  }

  recorded(): readonly RecordedCall[] {
    return this.calls;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.calls.push({
      method: req.method,
      path: req.path,
      ...(req.body !== undefined ? { body: req.body } : {}),
    });
    if (this.transportError !== undefined) {
      throw new TransportFailure(this.transportError);
    }
    const key = InMemoryTransport.key(req.method, req.path);
    const list = this.routes.get(key);
    if (list === undefined || list.length === 0) {
      throw new TransportFailure(`No route registered for ${key}.`);
    }
    // Consume one response per call so a retry can be scripted.
    const route = list.shift() as InMemoryRoute;
    return {
      status: route.status,
      body: route.body,
      ...(route.retryAfterSecs !== undefined
        ? { retryAfterSecs: route.retryAfterSecs }
        : {}),
    };
  }

  async stream(req: StreamRequest): Promise<StreamResponse> {
    this.calls.push({ method: req.method, path: req.path, body: req.body });
    if (this.transportError !== undefined) {
      throw new TransportFailure(this.transportError);
    }
    const key = InMemoryTransport.key(req.method, req.path);
    const list = this.streamRoutes.get(key);
    if (list === undefined || list.length === 0) {
      throw new TransportFailure(`No stream route registered for ${key}.`);
    }
    const route = list.shift() as InMemoryStreamRoute;
    const text = route.lines.map((line) => `${line}\n`).join('');
    return {
      status: route.status,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      }),
    };
  }
}
