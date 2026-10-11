# AGENTS.md — Aria-Electron

Repository memory for agents working in this repo. Keep it current.

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

## Backend errors

`AriaBackendError` (`src/backend/product-errors.ts`) carries `kind`, an
optional `requestId`/`retryAfterSecs`, and — for response failures — the HTTP
`status`, so a caller can distinguish a provider failure (502) from a backend
outage (503) without re-deriving it from the kind.
