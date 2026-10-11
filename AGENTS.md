# AGENTS.md — Aria-Electron

Repository memory for agents working in this repo. Keep it current.

## House rules

- **Do not write comments in code.** No doc-comments, no block comments, no
  inline explanations. The only exception is a comment that is genuinely
  load-bearing (a non-obvious invariant, a workaround, a subtle ordering or
  locking requirement, or a deliberate trade-off) — and even then, keep it to
  the one line that states the thing the code cannot. Do not restate the code,
  narrate a change, or describe non-local behavior.

## What this is

Aria-Electron is the native desktop shell for Aria. It speaks the Aria `/v1`
wire contract and integrates the Aria backend, the Directioner Platform Backend
(`/api/v1`), and the AI-Engineer task executor.

## Build and test

- Node ≥ 20, TypeScript strict ESM (NodeNext, `exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`, `verbatimModuleSyntax`).
- `npm run ci` = `npm run typecheck && npm run test` (vitest).
- `npm run build` = `tsc -p tsconfig.build.json`.
- Optional-property style: never assign `undefined` to an optional field; build
  the object with a spread guard instead
  (`...(x !== undefined ? { x } : {})`).

## Voice pipeline (`src/voice/`)

The pipeline is wake-listener -> session -> runtime, all local except speech:

- `wake-listener.ts` + `wake-word.ts` — wake-word detection and activation.
- `vad.ts`, `segmenter.ts`, `ring-buffer.ts`, `noise-reduction.ts` — audio
  front end. `push-to-talk.ts` bypasses wake-word detection entirely.
- `session.ts` (`VoiceSession`) — one turn: capture -> STT -> orchestrate ->
  optional TTS/playback. It emits the final `transcript` **before** calling the
  orchestrator, so a failed orchestration still reports what the user said. A
  cancellation is a clean stop (`session.cancelled`), never `session.failed`.
- `voice-runtime.ts` (`VoiceRuntime`) — owns activation policy, diagnostics,
  and voice reconciliation (`discoverVoices`).
- `speech.ts` (`BackendSpeechProxy`) and `orchestrator.ts` (`ChatOrchestrator`)
  are the only pieces that touch the backend, through `AriaClient`.
- `testing/` holds deterministic doubles (`FakeMicrophone`, `ManualSpeaker`,
  `SpeechDouble`, `RecordingOrchestrator`, `manualClock`); tests use these, not
  mocks of the module under test.

Voice config validation lives in `voice-config.ts` (`validateVoiceConfig`).
A configured voice is only rejected when the backend advertises a non-empty
catalog that omits it; an empty catalog is not proof the voice is missing.

## Runtime composition (`src/runtime.ts`)

`AriaRuntime` builds the voice runtime only when the desktop shell supplies a
`microphone` and `speaker`. `startVoice()` reconciles the configured voice
against `/v1/capabilities` before listening; a capabilities failure is
non-fatal and never disables push-to-talk.

## Interaction routing (`src/interaction/`)

The decision layer above the runtime. No UI, no window, no `electron`
dependency — callers ask the router what to do.

- `interaction-router.ts` — pure `routeActivation(activation, environment)`.
  Turns a raw activation into a `RoutedSession` (surface + input path) or a
  `RoutedControl`, or a typed `refused` result. A `RoutedSession` carries its
  `source` and `input` as data; downstream code must never infer them from a
  generic "a session exists" flag. `input: 'none'` is a real value (app launch,
  chat window), not "capture later". Voice input paths are
  `'push_to_talk' | 'wake_word'`.
- `interaction-controller.ts` (`InteractionController`) — the thin glue that
  executes a routing against the `VoiceRuntime` and the task-control seam. A
  refused routing executes nothing: the microphone is never opened on the
  strength of a request. The environment is read live, so a permission change
  is honoured.

Rules the router enforces, all with tests:
- App launch → Control Center, `input: 'none'`, no capture/STT/orchestration.
- Push-to-talk (hold the `?` key) → Orb, capture starts immediately; never
  consults wake-word detection, so it works with the detector disabled. Needs
  microphone permission.
- Wake word → Orb, capture only after activation, only while detection is
  enabled and the mic is permitted; a disabled detector never captures.
- `Win + Alt + A` → chat window, no capture.
- Typed text → chat, straight to orchestration, STT bypassed.
- `stop_playback` (interrupt) / `task_cancellation_requested` / `emergency_stop`
  are three distinct control outputs. A cancellation is a request, never a
  confirmed stop. The emergency stop engages locally and synchronously first,
  so a dead orchestration connection cannot undo it; it depends on no model
  inference and no connection.
- Two voice interactions never merge: an activation during an active session is
  refused (`voice_session_active`).

`VoiceActivationSource` in `voice/events.ts` (`'push_to_talk' | 'wake_word' |
'text'`) is reused as the vocabulary; the router's `VoiceInputPath` is that set
minus `'text'` (text is a routing input, not a voice capture path), so the
router does not introduce a conflicting enum.

## Desktop shell (`src/shell/`, `src/main.ts`, `src/preload.ts`)

The Electron foundation hosts the existing runtime; it does not reimplement it.

- `aria-shell.ts` (`AriaShell`) — lifecycle over an injected `Platform`.
  Builds exactly one `AriaRuntime` (in `main.ts`) and owns it for the session;
  closing or hiding a window never stops the runtime or cancels work. Normal
  launch opens only the Control Center; the Orb window starts hidden and is
  surfaced by an activation (push-to-talk / wake word), never by launch or the
  chat shortcut. Key events and the chat accelerator are routed through the
  existing `InteractionController`, so the shell has no routing logic of its
  own. `whenIdle()` resolves after queued input handlers settle — use it to
  make key/shortcut tests deterministic.
- `window.ts` (`WindowKind`, `WindowHandle`, `WindowOptions`, `KeyEvent`,
  `Platform`) — the seam that keeps the shell testable without Electron.
  `Platform = { windows, keys, shortcuts }`.
- `interaction-runtime.ts` (`VoiceInteractionRuntime`) — adapts a
  `VoiceRuntimeLike` to the controller's `InteractionRuntime` seam and counts
  captures started, so tests can assert "a capture start is the only thing that
  raises the Orb".
- `ipc.ts` / `ipc-handlers.ts` / `security.ts` — the renderer boundary. The
  bridge exposes exactly `status`, `sendText`, `stopPlayback` plus the
  Control Center operations `controlCenterState`, `settingsUpdate`,
  `accountSignIn`, `accountSignOut`; no token, capability or raw-`ipcRenderer`
  accessor crosses it. Renderer windows are context-isolated,
  `nodeIntegration: false`, web-security on, and deny external navigation and
  `window.open`. The main process registers a `window-all-closed` handler on
  purpose so Electron does not quit when the last window closes.
- `settings.ts` / `settings-file.ts` — persisted shell state. `normalizeSettings`
  keeps only known window kinds and rejects an unknown push-to-talk mode;
  optional ids (capture device, voice, language) survive only when present.
- `control-center/` (`state.ts`, `assemble.ts`, `control-center-service.ts`) —
  the Control Center domain. `ControlCenterService` reads live sources (Backend
  identity, public capabilities catalog, voice diagnostics, shell settings,
  supervisor records, activation inputs) through a narrow runtime port and
  returns one typed `ControlCenterState`. Failures stay honest: signed-out
  identity, backend outage with reason, empty/unknown voice catalog, denied
  microphone. `control-center-runtime.ts` adapts `AriaRuntime` + `AriaShell`.
- `control-center/renderer/control-center.ts` — the Control Center UI. Renders
  every section from the received state and enables a control only when its
  source allows it. Bundled by `scripts/bundle-renderer.mjs` with esbuild into a
  deferred classic script, because Chromium refuses `file://` ES-module imports.
- `electron-platform.ts`, `main.ts`, `preload.ts` are the only files that
  import `electron`; everything under `src/shell/` is dependency-free.
- `orb/` — the floating presence. `window-options.ts` holds the frameless /
  transparent / non-activating-panel options; `placement` (in `src/shell/`)
  anchors it to the right edge at 2/6 of the work area against an injected
  `ScreenProvider`. The renderer (`orb/renderer/orb.ts`, `src/renderer/orb.html`)
  draws exactly one circle — core, halo, glow — and keeps the window
  click-through except inside that circle via the `orbSetInteractive` channel
  and the pure `orb/hit-test.ts`. `orb/backdrop.ts` plans a full-screen material
  (macOS vibrancy, Windows acrylic) and honestly reports unsupported on Linux
  rather than faking a blur with an opaque rectangle.

Test baseline: 369 tests / 41 files. `src/shell/testing/doubles.ts` holds
`FakePlatform`, `FakeWindowFactory`, `FakeWindowHandle`, `FakeScreenProvider`,
`FakeKeyListener`, `FakeShellRuntime`, `FakeVoiceRuntime`.

## Chat and task submission (`src/chat/`)

The typed/chat turn pipeline above the voice runtime and the supervisor.

- `chat-service.ts` (`ChatService`) — the typed-turn surface. `sendText` goes to
  the Backend's conversational proxy through the voice runtime; when the reply
  carries an advisory `RouteHint` with `requires_confirmation: true`, the turn is
  *also* submitted as tracked work (`tasks.submit`) and the user turn is stamped
  with `submittedTaskId` / `routeCapability`. The hint is advisory only: a
  submitted request is `awaiting_approval`, never running, and a human still
  grants the approval. A `RouteHint` with no confirmation requirement is a plain
  conversation and is not submitted. `buildState` reconciles tracked tasks with
  the Backend before rendering so the surface shows current truth.
- `submission.ts` — the pure policy for the above: `shouldSubmit(route)`,
  `deriveTitle(text)` (the user's own words, bounded), and
  `operationForRoute(route)` (describes only the capability the hint carried;
  Aria never fabricates privileges, resources or risk).
- `chat-runtime.ts` (`createChatRuntime`) — adapts `AriaRuntime` to the
  `ChatRuntime` seam: `tasks.submit` calls `supervisor.submitRequest` then reads
  back the opened approval; `rememberApproval` is async and must be awaited
  before `approvalScope` will resolve.
- `state.ts` / `assemble.ts` — the `ChatState` the renderer consumes.

## Backend errors

`AriaBackendError` (`src/backend/product-errors.ts`) carries `kind`, an
optional `requestId`/`retryAfterSecs`, and — for response failures — the HTTP
`status`, so a caller can distinguish a provider failure (502) from a backend
outage (503) without re-deriving it from the kind.
