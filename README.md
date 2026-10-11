# Aria-Electron

Aria is the **local-first voice assistant desktop application** for the
Directioner ecosystem. This repository is the Linux-native desktop client. It is
not a web app and not a thin wrapper: it speaks Aria's `/v1` wire contract and
coordinates work through the Directioner Platform Backend.

## What is here

This is the **integration foundation** (Prompt 1/10): the client-side contract
and the task supervision that lets Aria turn a spoken request into tracked,
verifiable AI-Engineer work.

```
src/
  contract/
    aria-contract.ts       # Aria /v1 wire contract (speech + chat + streams)
    product-contract.ts    # Backend /api/v1 product contract (tasks, execution, approvals)
  backend/
    transport.ts           # the only component that touches the network
    task-client.ts         # authenticated product-surface client
    aria-client.ts         # Aria /v1 client (chat, stt, tts, NDJSON streams)
    ndjson.ts              # incremental newline-delimited JSON reader
    product-errors.ts      # error classification + recovery
    result.ts              # Result<T> — a failure is never a silent success
    testing/               # a real, stateful in-memory Backend for tests
  supervisor/
    supervisor.ts          # owns task supervision independently of any window
    engineer-events.ts     # AI-Engineer progress/questions/plan/permission signals
    approval-scope.ts      # what an approval authorizes; material-change detection
    task-store.ts          # durable supervision state (metadata only)
  config.ts                # runtime configuration
  runtime.ts               # composition root
  index.ts                 # public entry point
```

## The three-system integration

- **Aria `/v1`** (served by the Backend, mirrored in `contract/aria-contract.ts`):
  chat, speech-to-text, text-to-speech, and NDJSON streams.
- **Directioner Platform Backend `/api/v1`** (mirrored in
  `contract/product-contract.ts`): tasks, approvals, and the execution boundary
  (dispatch, leases, journal events, results).
- **AI-Engineer**, reached only through the Backend's execution boundary: Aria
  submits a task, the worker runs it, and progress/questions/plan/permission
  signals flow back as journal events.

## Truth rules the client enforces

These are the rules that keep Aria from lying to the user, and each has a test:

1. A submitted request is not a running task; a dispatch is not an execution.
2. Completion is not success unless `verification` is `confirmed`.
3. A cancellation **request** is not a confirmed stop.
4. A completion that beats a cancellation is `unknown`, never `cancelled`.
5. An unknown outcome stays unknown until reconciled; a mutating write is never
   retried automatically.
6. An approval authorizes exactly one operation at one plan version; a material
   change forces reassessment. Text is never authority.
7. A failure in the orchestration connection never becomes a privileged local
   fallback, and emergency stop never fabricates a stop it did not confirm.

## Development

```bash
npm install
npm run typecheck
npm test
```

## Configuration

| Variable | Meaning | Default |
| --- | --- | --- |
| `DIRECTIONER_BACKEND_URL` | Backend base URL (both `/api/v1` and `/v1`) | `http://127.0.0.1:8080` |
| `DIRECTIONER_REQUEST_TIMEOUT_MS` | Per-request timeout for unary calls | `30000` |

Aria carries only a short-lived user session token, held in memory and never
written to disk. It holds no provider keys and no privileged local socket.
