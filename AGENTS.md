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

## Backend errors

`AriaBackendError` (`src/backend/product-errors.ts`) carries `kind`, an
optional `requestId`/`retryAfterSecs`, and — for response failures — the HTTP
`status`, so a caller can distinguish a provider failure (502) from a backend
outage (503) without re-deriving it from the kind.
