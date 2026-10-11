/**
 * The Aria integration runtime: the composition root that wires the product
 * client and the task supervisor to a configured Backend.
 *
 * The desktop shell (Electron main process, Control Center, Orb) constructs one
 * runtime at startup and uses it for the whole session. The runtime owns the
 * in-memory session token and the durable supervision store; it survives window
 * churn because it is not owned by a window.
 *
 * This is the boundary the Aria `/v1` voice surface and the UI both sit above:
 * speech turns in, requests are submitted through the Backend orchestration
 * boundary, and supervision flows back out.
 */

import { AriaClient } from './backend/aria-client.js';
import { TaskClient } from './backend/task-client.js';
import { FetchTransport, SharedToken } from './backend/transport.js';
import { loadConfig, type AriaConfig } from './config.js';
import { AriaSupervisor } from './supervisor/supervisor.js';
import { FileTaskStore, InMemoryTaskStore, type TaskStore } from './supervisor/task-store.js';

export interface AriaRuntimeOptions {
  readonly config?: AriaConfig;
  /** A durable store path; omit for an in-memory store (tests, ephemeral). */
  readonly statePath?: string;
  readonly store?: TaskStore;
  /** Injectable fetch for tests and non-global-fetch runtimes. */
  readonly fetchImpl?: typeof fetch;
}

export class AriaRuntime {
  readonly supervisor: AriaSupervisor;
  readonly aria: AriaClient;
  private readonly tokens: SharedToken;

  constructor(options: AriaRuntimeOptions = {}) {
    const config = options.config ?? loadConfig();
    this.tokens = new SharedToken();
    const transport = new FetchTransport({
      baseUrl: config.backendBaseUrl,
      timeoutMs: config.requestTimeoutMs,
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    });
    const client = new TaskClient({ transport, tokens: this.tokens });
    this.aria = new AriaClient({ transport, tokens: this.tokens });
    const store =
      options.store ??
      (options.statePath !== undefined
        ? new FileTaskStore(options.statePath)
        : new InMemoryTaskStore());
    this.supervisor = new AriaSupervisor({ client, store });
  }

  /** Start the runtime: restore persisted supervision state. */
  start(): void {
    this.supervisor.start();
  }

  /** Set (or clear) the in-memory session token after sign-in / sign-out. */
  setSessionToken(token: string | undefined): void {
    this.tokens.set(token);
  }

  /** Whether a session token is present. */
  isSignedIn(): boolean {
    return this.tokens.current() !== undefined;
  }
}
