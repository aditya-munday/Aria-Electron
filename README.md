# Aria-Electron

[![release](https://github.com/aditya-munday/Aria-Electron/actions/workflows/release.yml/badge.svg)](https://github.com/aditya-munday/Aria-Electron/actions/workflows/release.yml)
[![latest release](https://img.shields.io/github/v/release/aditya-munday/Aria-Electron?label=release)](https://github.com/aditya-munday/Aria-Electron/releases/latest)

Aria is the **local-first voice assistant desktop application** for the
Directioner ecosystem. This repository is the Linux-native desktop client. It is
not a web app and not a thin wrapper: it speaks Aria's `/v1` wire contract and
coordinates work through the Directioner Platform Backend.

## What is here

Aria is the native desktop shell plus the integration foundation beneath it: the
client-side contract, the task supervision that turns a spoken request into
tracked AI-Engineer work, and the Electron surfaces (Control Center, Orb, chat)
that present it.

```
src/
  contract/
    aria-contract.ts       # Aria /v1 wire contract (speech + chat + streams)
    product-contract.ts    # Backend /api/v1 product contract (tasks, execution, approvals)
    capability-catalog.ts  # versioned description of what the runtime can do
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
  voice/                   # wake-word, push-to-talk, VAD, echo cancellation, sessions
  interaction/             # pure activation routing + the controller that executes it
  control/                 # honest stop / cancel / mute / emergency-stop
  shell/                   # Electron lifecycle, windows, tray, IPC, security
  orb/                     # the floating presence (state, hit test, dismissal)
  chat/                    # typed-turn service and chat renderer
  control-center/          # the ten-section Control Center domain and renderer
  renderer/                # shared stylesheets and HTML for the renderer windows
  config.ts                # runtime configuration
  runtime.ts               # composition root
  main.ts / preload.ts     # the Electron entry point and the renderer bridge
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
| `ARIA_BACKEND_URL` | Backend base URL (both `/api/v1` and `/v1`); https unless loopback | `https://api.adityamunday.codes` |
| `ARIA_LOGIN_URL` | Origin serving the device-code sign-in endpoints `/api/auth/cli/*` | `https://api.adityamunday.codes` |
| `ARIA_REQUEST_TIMEOUT_MS` | Per-request timeout for unary calls | `30000` |
| `ARIA_SESSION_TOKEN` | Seeds the in-memory session token at startup (never written to disk) | unset |
| `ARIA_CONFIG_DIR` | Overrides the config directory holding `credentials.json` | `~/.config/aria` |
| `ARIA_FINGERPRINT_PATH` | Overrides the stored machine-fingerprint file | `~/.config/aria` |
| `ARIA_ENABLE_GPU` / `ARIA_DISABLE_GPU` | Force the Chromium GPU path on or off (otherwise probed from `/dev/dri`) | probed |
| `ARIA_WAKE_ENGINE` | Selects an alternate wake-word engine module (e.g. `voxrt`) | in-process |
| `ARIA_GRAPHICS` | Graphics acceleration: `auto` \| `on` \| `off` | `auto` |
| `ARIA_OZONE` | Ozone platform hint (`auto`, `wayland`, `x11`) | session-derived |

The `ARIA_SESSION_TOKEN` the user supplies is held in memory and never written
to disk. A successful device-code sign-in is different: it writes one durable
account credential to `~/.config/aria/credentials.json`, owner-only (`0600`), in
the Directioner CLI's own shape so an existing CLI login is reused. Aria holds
no provider keys and no privileged local socket.
