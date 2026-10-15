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
wire contract and integrates the backend, its product surface (`/api/v1`), and
the AI-Engineer task executor.

## Build and test

- Node ≥ 20, TypeScript strict ESM (NodeNext, `exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`, `verbatimModuleSyntax`).
- `npm run ci` = `npm run typecheck && npm run test && npm run build && npm run security:check`.
- `npm run security:check` (`scripts/security-check.mjs`) fails on an Electron
  downgrade below the supported floor, a high/critical production-dependency
  advisory, or a weakened renderer CSP. Electron ships inside the `.deb` but is a
  devDependency, so `npm audit --omit=dev` never sees it and the floor is what
  guards it. The floor is bumped whenever the runtime is upgraded.
- `npm run build` = `tsc -p tsconfig.build.json` plus the renderer copy/bundle.
- `npm run pack:deb` = build, then `electron-builder --linux deb --x64 --publish never`
  into `release/` (`aria-electron_<version>_amd64.deb`). The package installs to
  `/opt/Aria`, provides `/usr/bin/aria-desktop` and an `aria-desktop.desktop`
  launcher. `--publish never` matters: without it electron-builder treats a tag
  build as an implicit publish and aborts when no `GH_TOKEN` is set.
- `npm run smoke:deb` = `pack:deb`, then `security:check`, `verify:package`, then
  `scripts/smoke-deb.mjs`, which installs the `.deb` and boots the app sandboxed
  (no `--no-sandbox`). Install the package with `apt` (not a bare `dpkg -i`) so
  declared dependencies (`libnotify4`, `libxss1`, …) resolve and its postinst
  runs; pass `--no-install` when it is already installed.
- The smoke launches through `xvfb-run` when present, else a real `DISPLAY`, else
  Ozone headless. Electron's BrowserWindow needs an X server: under Ozone
  headless in a display-less container it SIGSEGVs (even a trivial window), a
  hierarchy with no window boots fine. It refuses to run unless the sandbox is
  usable — `/opt/Aria/chrome-sandbox` root-owned mode 4755, or unprivileged user
  namespaces work — and `--allow-unconfigured-sandbox` overrides that. On a host
  where Chromium's user-namespace sandbox is blocked, the SUID helper is what
  makes the sandbox engage, so it must be 4755.
- `src/shell/gpu-policy.ts` decides Chromium's GPU path before `app.whenReady`.
  A host whose GPU stack is half-present (a Mesa driver that will not load, a
  container with no usable render node) makes Chromium's GPU init fail and the
  process SIGSEGV at startup, before any window — the crash is a launch failure,
  not a blank Orb. Hardware acceleration is enabled only when a readable
  `/dev/dri` render node exists; otherwise the app calls
  `disableHardwareAcceleration()` and renders in software (the Orb degrades to
  its CSS fallback). A GPU-mode run is marked on disk (`gpu-crash.json` in
  userData) and the mark is cleared only on a clean quit, so a crash makes the
  next launch back off to software on its own. `ARIA_ENABLE_GPU` /
  `ARIA_DISABLE_GPU` override the probe; `ARIA_ENABLE_GPU` also overrides the
  crash backoff. `src/shell/gpu-policy.test.ts` covers the probe, the backoff
  and the marker.
- `.github/workflows/release.yml` runs on `aria-v*` tags: a `gate` job runs
  `npm run ci`, then `package` builds the `.deb`, smoke-tests the install, and
  attaches the `.deb` plus its `.sha256` to the GitHub release. The release page
  carries install and checksum-verification steps in its body. The package is
  located with `ls release/*.deb | sort -V | tail -n1` (and `smoke-deb.mjs`
  mirrors that ordering) so the highest version wins even if `release/` holds
  more than one build; a plain lexicographic sort would pick the wrong file.
  A 0 B download of the asset is a GitHub asset-proxy artifact, not a package
  defect: the `.sha256` is attached so a downloader can tell a truncated file
  from a good one.
- Optional-property style: never assign `undefined` to an optional field; build
  the object with a spread guard instead
  (`...(x !== undefined ? { x } : {})`).

## Renderer surfaces (Control Center, Chat, Orb)

- The three renderer surfaces (`src/control-center/renderer/`,
  `src/chat/renderer/`, `src/orb/renderer/`) are plain DOM builders bundled to
  `dist/renderer/*.js` by `scripts/bundle-renderer.mjs`. They import shared
  browser modules by relative path (e.g. `../../renderer/sfx.js`); esbuild
  inlines those into each surface bundle, so a shared module never needs its own
  `<script>`.
- A surface that polls its state on an interval must key its "did anything
  change" check on the *drawn* fields only. `ChatState.generatedAt` and
  `OrbPresenceView.updatedAt` are fresh ISO timestamps on every read, so
  including them makes the key never match and the surface repaints on every
  tick. Chat strips `generatedAt` (`stateKey`); the Orb strips `updatedAt`.
- The Orb must never rebuild its DOM per poll. `renderOrb` updates an existing
  sphere in place when the theme is unchanged; `bootstrapOrb` calls it only when
  the presence actually changes. Rebuilding allocates a new WebGL context each
  time (`canvas.getContext('webgl')` on a fresh canvas) and never releases the
  old one, so the app stutters and then crashes when the browser's context
  budget (~16) is exhausted. A hidden presence paints nothing and stops the
  shader.
- The palette and motion live in `src/renderer/theme.css`, which every surface
  imports via `@import url('./theme.css')`. It is aligned with the Beyonders
  design system (violet `#a78bfa`, basalt surfaces, Inter). Keep the token names
  (`--ink-*`, `--text-*`, `--accent*`, `--font-*`, `--radius*`, `--ease*`);
  the surface CSS and `theme.test.ts` depend on them. Decorative motion must
  animate only `transform`/`opacity`/`box-shadow` and stay disabled under
  `prefers-reduced-motion` and `html[data-motion='reduced']`.
- Sound is `src/renderer/sfx.ts`: Web Audio synthesis, no audio assets and no
  CSP change (`media-src`/`default-src 'none'` stay intact). `attachCues(doc)`
  wires ambient button/key cues; surfaces emit semantic cues with
  `emitCue(doc, cue)` or call `playCue`. It is inert without an `AudioContext`,
  silent when muted (`aria.sfx.muted`) or under reduced motion, and throttles
  repeats.

## Backend and configuration (`src/config.ts`, `src/runtime.ts`)

The backend base URL is `https://api.adityamunday.codes` by default. Config is
read from the environment: `ARIA_BACKEND_URL` overrides the base URL and
`ARIA_SESSION_TOKEN` seeds the in-memory session token at startup (never written
to disk). `normalizeBaseUrl` rejects a non-http(s) URL or one with embedded
credentials.

The device-code sign-in flow is served by the same backend: `ARIA_LOGIN_URL`
overrides its origin (default `https://api.adityamunday.codes`), where
`/api/auth/cli/{code,status}` live. It is deliberately *not* the marketing site:
the website's `/cli/login` page only relays approvals to that backend origin, so
the desktop client and the browser reach the same surface from opposite sides.

The Aria model is fixed: `ARIA_MODEL` is `groq/llama-3.3-70b-versatile`
(provider `groq`, display name `Llama 3.3 70B (Groq)`). It is exposed on
`AriaConfig.model` and rendered read-only in the Control Center — there is no
provider chooser and no model selection surface. `AriaRuntime` exposes its
`config` and seeds the session token from `loadSessionToken()` unless a
`sessionToken` option is supplied.

## Error reporting and settings propagation (`src/shell/error-reporting.ts`)

`ErrorReporter` records renderer load failures, `render-process-gone` exits and
process-level `uncaughtException`/`unhandledRejection` events with a source and
message, keeping the most recent entries and forwarding each to a sink (the
main process writes them to stderr). It never fabricates success.

`SettingsStore.subscribe` (implemented by both the in-memory and file stores)
lets the main process push a settings change to the voice runtime
(`setWakeWordEnabled`, `setPushToTalkMode`, `setSpeakResponses`,
`setSpeechOutput`) the moment it is saved, rather than only applying it on the
next Control Center refresh. `applySettingsToRuntime` in `src/main.ts` is the
single applier, called at startup, on every settings change, and on sign-in, so
a persisted `speakResponses` is honoured on the first voice turn rather than
only after an unrelated toggle. Local activation — the push-to-talk mode and
wake-word listening — is applied even while signed out; gating it on sign-in
would leave a signed-out user unable to speak to the app at all, so only the
account-scoped preferences wait for an identity. The renderer reads current
settings through the
`aria:shell:settings` IPC channel. `setSpeechOutput` changes the
voice/language/speed used by subsequent sessions only; a session already in
flight keeps the output it started with.

## Voice pipeline (`src/voice/`)

The pipeline is wake-listener -> session -> runtime, all local except speech:

- `wake-listener.ts` + `wake-word.ts` — wake-word detection and activation.
  The default detector is the dependency-free JavaScript phrase spotter
  (`wake-phrase-engine.ts`, `createWakePhraseEngine`). It runs in the main
  process, so the engine must never be native code: a WebAssembly or native
  fault there is a SIGSEGV the JS layer cannot trap, and the process dies before
  any window appears. The engine is an energy/activity segmenter feeding a
  spectral DTW match against the wake phrase. Each frame is reduced to formant
  (F1/F2), tonal↔noisy and band-split features; the phrase templates are built
  by rendering the phrase through `formant-synth.ts` and the engine's own
  featurizer, so template and audio share one feature space. A segment must be
  the right length, voiced-dominant (`minVoicedFraction`, low enough to admit
  the fricative-heavy default "Hey Assistant") and spectrally varied, then match
  a speaking-rate template (ensemble 0.6–1.4x) below `matchThreshold`. The
  segmenter tracks the ambient level adaptively (`adaptNoiseFloor`): it falls
  quickly toward a quieter frame and rises slowly, so a loud room does not read
  as permanent activity and the segment still closes.
  The on-device VoxRT engine (`voxrt-detector.ts`, `createVoxrtDetector`) is
  opt-in, selected with `ARIA_WAKE_ENGINE=voxrt`: `@voxrt/wake-word-browser`
  ships a WebAssembly runtime and a trained `voxrt_wake_word.vxrt` model that
  spots "Hey Assistant" on 16 kHz mono audio with no network, no API key and no
  native build — but its native runtime lives in the main process, so a fault in
  it takes the process down. `ARIA_WAKE_ENGINE` also points at an alternate
  native engine module (`createNativeWakeWordDetector`), and `ARIA_WAKE_MODEL`
  overrides the model path; a missing package or model fails observably
  (`device_unavailable`), never silently.
  `wake-word.ts` wraps a detector in `EngineWakeWordDetector`.
  `DEFAULT_WAKE_WORD.enabled` stays `false` at the runtime layer because
  product-level activation comes from shell settings
  (`DEFAULT_SETTINGS.wakeWordEnabled`). `formant-synth.ts` is the single renderer
  shared by the phrase engine's templates and the test fixture
  (`testing/fake-audio.ts` `speakPhrase`), so a fixture and a template cannot
  drift apart.
- `vad.ts`, `segmenter.ts`, `ring-buffer.ts`, `noise-reduction.ts` — audio
  front end. `push-to-talk.ts` bypasses wake-word detection entirely.
- `echo-cancellation.ts` — `EchoCanceller` (cascaded NLMS adaptive filter with
  double-talk detection and a residual echo suppressor) and `FarEndReference`,
  the queue of playback PCM used as the reference signal. `VoiceRuntime` taps the
  speaker once (`Speaker.setReferenceTap`) and shares that single reference with
  the wake listener and every session, so both cancel Aria's own playback echo.
  A speaker without the optional tap (or a config with echo cancellation off)
  leaves `farEnd` undefined and the pipeline runs unmodified.
- `session.ts` (`VoiceSession`) — one turn: capture -> STT -> orchestrate ->
  optional TTS/playback. It emits the final `transcript` **before** calling the
  orchestrator, so a failed orchestration still reports what the user said. A
  cancellation is a clean stop (`session.cancelled`), never `session.failed`.
- `voice-runtime.ts` (`VoiceRuntime`) — owns activation policy, diagnostics,
  and voice reconciliation (`discoverVoices`).
- `speech.ts` (`BackendSpeechProxy`) and `orchestrator.ts` (`ChatOrchestrator`)
  are the only pieces that touch the backend, through `AriaClient`.
  `SpeechProxy` also exposes optional `transcribeStream`/`synthesizeStream`; when
  the Backend advertises `streaming_stt`/`streaming_tts` (wired in through
  `VoiceRuntime.setStreamingSupport`), `VoiceSession` consumes the stream:
  partial `transcript` events are emitted as they arrive (the authoritative
  final transcript still comes from the caller), and synthesis chunks are played
  incrementally through `Speaker.playStream`. A stream that ends without a final
  event, or a synthesis stream that fails, is a failed turn — never a fabricated
  transcript or a claimed playback. Stream failures are mapped onto the same
  `VoiceError` taxonomy as the batch calls (`voiceErrorFromStream`).
  `session.ts` `classifyStageError` keeps a real `VoiceError` and only coerces an
  unknown throw with the stage fallback (`speech_failed` for STT/TTS,
  `backend_unavailable` for orchestration); a cancellation is always reported as
  `cancelled`. `backend/ndjson.ts` `readNdjson` cancels its reader in `finally`,
  so a consumer that stops at the terminal event does not leave the HTTP body
  unconsumed and the connection pinned.
- `orchestrator.ts` (`ChatOrchestrator`) also owns chat streaming:
  `respondStream` consumes `/v1/chat/stream`, forwards each `delta` to the
  session (`response.delta` events) and returns the authoritative text. The
  session uses it only when the Backend advertises `streaming_chat` **and** the
  orchestrator implements it (`VoiceRuntime.setStreamingSupport`); otherwise the
  turn falls back to the batch `respond`. A route hint on the final event is
  surfaced, never treated as authorization. Deltas are fed to `text-segmenter.ts`,
  which releases the first speakable sentence at a smaller threshold than later
  ones, so synthesis starts on the first sentence while the reply is still
  streaming (`response.delta` events carry the running text).
- `os-routing.ts` — the client half of the OS/CLI route surface, pure and
  testable. When `ARIA_OS_ROUTING` is on and a reply carries a route hint with
  `requires_confirmation: true`, the session speaks the Backend's own question
  with a yes/no cue (`confirmationReply`) and remembers the hint across turns
  (`VoiceRuntime` carries it, since each turn is a fresh session). A reply that
  reads as an affirmation (`interpretConfirmation`) re-sends the turn with
  `confirm: true` so the Backend — never Aria — executes the proposed operation;
  a denial or an unrelated reply is sent verbatim. While the flag is off the hint
  is ignored entirely. The route hint is advisory throughout: Aria has no
  authority over the operating system and never claims success on a hint alone.
- Latency flags: `ARIA_VOICE_STREAMING` (consume the streaming endpoints; on by
  default), `ARIA_VAD_SILENCE_MS` (end-of-speech silence), `ARIA_VOICE_DEBUG`
  (`turn.metrics`: `firstDeltaMs`, `firstAudioMs`, `maxAudioGapMs` from the
  moment speech ends), and `ARIA_VOICE_FAST` (streaming everywhere, an 8-char
  first sentence, ~350 ms silence).
- Synthesis output controls (`pitch`, `volume`, `style`) are an optional,
  additive Backend capability (`output_controls`). `VoiceRuntime.setOutputControls`
  records what the Backend advertises and drops any control it does not offer, so
  a session never sends one that is unsupported. They ride on the same
  contract → client → speech proxy → runtime → session path as voice/language/speed.
- `device.ts` defines the `Microphone`/`Speaker`/capture seams; `audio-tool.ts`
  probes the host (once, at startup) for a command-line recorder and player
  (`parec`/`arecord`/`pw-record`, `pacat`/`aplay`/`pw-play`) and exposes the
  raw-PCM argv for each. `capture-tool.ts` (`StreamingCapture`, `PcmPlayback`)
  drives those processes: it slices the recorder stream into fixed frames and
  converts s16le to Float64. `native-audio.ts` (`createNativeAudio`) composes a
  `Microphone`/`Speaker` over that backend; with no recorder the microphone
  denies permission and offers no devices, so push-to-talk is honestly inert
  rather than silently broken.
- `voice-runtime.ts` `start()` awaits `refreshDevices()` and only starts the
  wake listener when a capture-capable device exists; a buffer-only microphone
  (the fake, or a host with no recorder) stands the listener down with a
  `device_unavailable` diagnostic while push-to-talk keeps working. This is why
  the wake listener is gated on real capture capability, not merely on the
  detector being enabled.
- The shipped app does **not** capture through the command-line recorder. It
  owns the microphone from a hidden renderer so wake word works on a stock host
  with no `parec`/`arecord`/`pw-record`: `renderer-microphone.ts`
  (`RendererMicrophone`) is the `Microphone` the runtime drives, and it speaks to
  a hidden `voice` window over IPC (`shell/ipc.ts` channels
  `aria:voice:capture-{start,stop,pcm,status}`; `RendererCaptureTransport` is the
  seam, faked in tests). The renderer half is `voice/renderer/voice.ts`
  (`VoiceCapture`, bundled to `dist/renderer/voice.js` and loaded by
  `src/renderer/voice.html`): `getUserMedia` -> resample to 16 kHz -> chunk into
  `round(frameMs * sampleRate / 1000)`-sample frames -> `sendVoicePcm`. The
  main process runs the VoxRT detector and the sessions on those frames, so
  detection is unchanged. The `voice` window is created by
  `AriaShell.ensureVoiceWindow()` (`load()`s it, never shows it, keeps it out of
  the persisted `openWindows`), gets `backgroundThrottling: false` in
  `electron-platform.ts`, and the app-level `media`/`audioCapture` permission is
  already granted to app frames in `shell/security.ts`. A start command that
  races the renderer's subscription is not lost: the renderer reports `idle` on
  load and `RendererMicrophone` re-sends `start` on every `idle` while it wants
  capture; a `stop` before the renderer confirms fails the pending start fast and
  drops any partial frame so it cannot bleed into the next capture.
- `session.ts` finalizes the utterance on push-to-talk release even when no
  speech was detected (the VAD is off by one at the boundary), and a release
  that lands before the first frame completes the turn instead of hanging.
  `VoiceRuntime.finishSession` clears the push-to-talk controller when a session
  ends without a release (VAD silence or the max-duration cap), so the next
  press starts a new capture instead of being read as a duplicate press.
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
- Push-to-talk (hold the `F5` key) → Orb, capture starts immediately; never
  consults wake-word detection, so it works with the detector disabled. Needs
  microphone permission. The global accelerator is `Win + Alt + T`
  (`PUSH_TO_TALK_ACCELERATOR = 'Super+Alt+T'`), the single source the shell and
  the Control Center both read; a global grab reports key-down only, so
  the shell treats each press per the mode (`hold` pairs it with a release).
  `window.ts` also exports candidate lists (`CHAT_SHORTCUT_ACCELERATORS`,
  `PUSH_TO_TALK_ACCELERATORS`) because a desktop environment may already hold the
  first choice — GNOME grabs `Super+Alt+T` itself — so the shell walks the list
  and registers the first accelerator the OS accepts. `shortcutStatus()` reports
  the accelerator that is actually active (or the first tried when none is), and
  the Control Center Activation tab offers a "Retry push-to-talk shortcut" /
  "Retry chat shortcut" control (`retryShortcuts` → `AriaShell.retryShortcuts`),
  so a refused grab leaves the feature reachable rather than silently dead.
  The Control Center retry drives the same `activatePushToTalk` path as the
  accelerator, so a tap means the same thing however it arrives: in `toggle`
  mode it starts capture and the next tap finalizes it; in `hold` mode a tap
  starts capture and the next tap releases it. It is never a press paired with
  an immediate release, which the controller would reject as a zero-length hold.
  The Control Center push-to-talk status reflects the runtime's real capture
  state (`setPushToTalkActive`, fed in `main.ts` from the voice runtime's
  `session.state`), not the shell's tap bookkeeping, so a capture
  that ends on its own (VAD silence, empty/too-short utterance, max-duration,
  failure) stops advertising "Stop listening" and the next tap is a fresh press.
- Wake word → Orb, capture only after activation, only while detection is
  enabled and the mic is permitted; a disabled detector never captures.
- `Win + Alt + A` (accelerator `Super+Alt+A`) → chat window, no capture.
- Typed text → chat, straight to orchestration, STT bypassed. Chat is
  text-to-text: a typed turn never speaks and never raises the Orb, so the chat
  surface stays a chat surface. Speech output belongs only to a voice turn
  (push-to-talk or wake word); `runText` disables the session's speech stream,
  and `main.ts` raises the Orb only for a non-`text` activation.
- `stop_playback` (interrupt) / `task_cancellation_requested` / `emergency_stop`
  are three distinct control outputs. A cancellation is a request, never a
  confirmed stop. The emergency stop engages locally and synchronously first,
  so a dead orchestration connection cannot undo it; it depends on no model
  inference and no connection.
- Two voice interactions never merge: an activation during an active session is
  refused (`voice_session_active`). `main.ts` supplies the live session state
  (`voice.diagnostics().sessionId !== undefined`) as the router's
  `voiceSessionActive`, so the refusal reflects a real session, not a constant.

`VoiceActivationSource` in `voice/events.ts` (`'push_to_talk' | 'wake_word' |
'text'`) is reused as the vocabulary; the router's `VoiceInputPath` is that set
minus `'text'` (text is a routing input, not a voice capture path), so the
router does not introduce a conflicting enum.

## Desktop shell (`src/shell/`, `src/main.ts`, `src/preload.ts`)

The Electron foundation hosts the existing runtime; it does not reimplement it.

- `aria-shell.ts` (`AriaShell`) — lifecycle over an injected `Platform`.
  Builds exactly one `AriaRuntime` (in `main.ts`) and owns it for the session;
  closing or hiding a window never stops the runtime or cancels work. Normal
  launch opens only the Control Center; the Orb window is not created until an
  activation (push-to-talk / wake word), the tray, or a settings change surfaces
  it, so launch never depends on it. Key events and the chat accelerator are
  routed through the existing `InteractionController`, so the shell has no
  routing logic of its own. `whenIdle()` resolves after queued input handlers settle — use it to
  make key/shortcut tests deterministic. `setShortcuts({ chat, pushToTalk })`
  registers or releases each global accelerator and `shortcutStatus()` reports
  what the OS actually accepted, never an assumed grab; `stop()` releases both.
  Push-to-talk is gated by an injected `pttAllowed` predicate (wired in
  `main.ts` to microphone permission), so a denied microphone leaves the
  shortcut inert even when the setting is on. Disabling push-to-talk mid-hold
  releases the stranded capture rather than leaving the microphone running, and
  a mode change mid-gesture resets the local press/release pairing so a toggle
  press is never paired with a hold release. `electron-platform.ts` also emits a
  synthetic `key_up` on window blur for any key held down, because a focused key
  released while the window lost focus never arrives as a `keyUp`.
- `window.ts` (`WindowKind`, `WindowHandle`, `WindowOptions`, `KeyEvent`,
  `Platform`) — the seam that keeps the shell testable without Electron.
  `Platform = { windows, keys, shortcuts }`. `WindowOptions.launchHidden`
  marks the window the shell preloads but leaves off screen on a login launch
  (`--hidden`).
- Resident, tray-free lifecycle: Aria has no system tray. `main.ts` passes
  `launchHidden` from `process.argv.includes('--hidden')`. Closing a window only
  hides it; the process stays resident so a global shortcut, a wake word, or an
  autostart launch can still surface a window. Quit is an explicit user action —
  the Control Center General tab calls `shellQuit` → `IpcHost.quit()` →
  `app.quit()` — never an implicit side effect of the last window closing.
  `shell/autostart.ts` (`createAutostartManager`, `autostartEntry`) writes an XDG
  autostart desktop entry whose `Exec` carries the same hidden-launch argument
  and an `X-GNOME-Autostart-Delay`, so a login launch comes up in the background
  and never steals focus. `main.ts` takes a single-instance lock before
  `app.whenReady()`: a second launch (which could not grab the global shortcuts
  the OS only grants once) hands focus to the live instance and exits, so the
  shortcuts keep working from cold. `startOnLogin` defaults **on**, and the
  autostart setting is (re)applied at launch and after a successful sign-in —
  not only on a settings change — so the shortcuts are registered as soon as the
  shell knows it is signed in. The autostart entry and settings persistence are
  both skipped while signed out.
- `orb/dismiss.ts` (`createOrbDismissal`) — the Orb's transient lifecycle. It
  subscribes to the voice runtime and, once a turn goes quiet (spoken output
  finished, response text without speech, failed, cancelled, or an empty final
  transcript), hides the Orb after a short grace period, cancelling the timer the
  moment a new turn starts. `main.ts` supplies `hide` (a no-op while the user has
  pinned the Orb with `showOrb`) and raises the Orb on a non-`text`
  `session.started`, so the Orb appears for a voice turn and steps away a couple
  of seconds after it ends instead of lingering forever. A typed chat turn never
  raises it.
- `interaction-runtime.ts` (`VoiceInteractionRuntime`) — adapts a
  `VoiceRuntimeLike` to the controller's `InteractionRuntime` seam and counts
  captures started, so tests can assert "a capture start is the only thing that
  raises the Orb".
- `ipc.ts` / `ipc-handlers.ts` / `security.ts` — the renderer boundary. The
  bridge exposes exactly `status`, `sendText`, `stopPlayback` plus the
  Control Center operations `controlCenterState`, `settingsUpdate`,
  `accountSignIn`, `accountSignOut`, `previewVoice` and the explicit
  `quit`; no token, capability or raw-`ipcRenderer` accessor crosses it.
  Renderer windows are context-isolated,
  `nodeIntegration: false`, web-security on, and deny external navigation and
  `window.open`. The main process keeps a `window-all-closed` handler that does
  **not** quit: closing every window leaves Aria resident, and only the Control
  Center Quit control quits.
  `registerIpcHandlers` strips the leading `IpcMainInvokeEvent` from every
  `ipcMain.handle` callback (`(_event, ...args)`), so a handler reads its real
  payload, not the event object. `RecordingRegistrar` in the test mirrors that
  `(event, ...args)` arity so a mis-read argument cannot pass.
- Destroyed-window safety: a window the OS closed leaves a dead handle behind, and
  acting on it throws `Object has been destroyed`. `WindowHandle.isDestroyed()`
  reports it (`ElectronWindowHandle` also guards `visible`); the factory's
  `window.on('closed')` marks the handle destroyed and calls
  `ElectronPlatformOptions.onWindowClosed`, which `main.ts` wires to
  `AriaShell.forgetWindow(kind)`. `AriaShell.open()` drops a destroyed handle and
  rebuilds rather than touching it, so a teardown that races a settings read or a
  re-open never crashes the shell or leaves the Orb stuck on screen.
- `control-center/sign-in.ts` — `verifySignIn` resolves a pasted session token
  against the Backend before treating the user as signed in, and rolls the token
  back when the identity read fails, so a rejected credential never leaves a
  half-signed-in shell. The outcome carries the real identity or the classified
  failure (`recoveryForError`), never a fabricated success. A sign-out reports
  `ok: true, signedIn: false` — a successful action that leaves the shell signed
  out — so a consumer reading `signedIn` is never told the opposite of the truth.
- `settings.ts` / `settings-file.ts` — persisted shell state. `normalizeSettings`
  keeps only known window kinds and rejects an unknown push-to-talk mode;
  optional ids (capture device, voice, language) survive only when present.
  `createFileSettingsStore` persists atomically (write a sibling, then rename)
  with owner-only (`0600`) permissions, so a crash mid-write cannot truncate
  `shell-settings.json` into a file the next load reads as defaults.
- `control-center/` (`state.ts`, `assemble.ts`, `control-center-service.ts`) —
  the Control Center domain. `ControlCenterService` reads live sources (Backend
  identity, public capabilities catalog, voice diagnostics, shell settings,
  supervisor records, activation inputs) through a narrow runtime port and
  returns one typed `ControlCenterState`. Failures stay honest: signed-out
  identity, backend outage with reason, empty/unknown voice catalog, denied
  microphone. `control-center-runtime.ts` adapts `AriaRuntime` + `AriaShell`.
  The renderer exposes the ten canonical sections from All-Knowledge §7.2 as
  tabs: Profile, Account, Voice & Language, Activation, Aria Configuration,
  Privacy & Permissions, Integrations, Tasks & History, Diagnostics, General.
  The Integrations tab also renders the versioned capability catalog.
- `contract/capability-catalog.ts` — the versioned capability catalog
  (`CAPABILITY_CATALOG_VERSION`, `CapabilityEntry`, `resolveCapabilities`). It
  describes what the runtime can do (identifiers, privilege, approval policy,
  risk, side effects, verification, cancellation, retry, reversibility,
  recovery) and marks each entry `supported` with an honest `reason` when the
  live runtime cannot honor it. The catalog *describes*; it never grants
  authority (All-Knowledge §9.1, §8.5). Do not fabricate a capability: gate on a
  real signal (voice engine present, signed in) and report the limitation.
- `control-center/renderer/control-center.ts` — the Control Center UI. Renders
  every section from the received state and enables a control only when its
  source allows it. The Voice & Language tab is a studio: a summary of the
  current output, a searchable/filterable voice grid (accent/language facets)
  with per-voice selection and inline audition, a speed slider, STT-language
  chips, a push-to-talk mode control and spoken-response toggle. Audition goes
  through `previewVoice` → the voice runtime; `state.voice.previewAvailable`
  (derived from `capabilities.ok`, not from a chosen voice) keeps Preview enabled
  whenever the Backend can synthesize, and the reason is surfaced when it cannot,
  so the control is never dead while a sample is actually servable. The Profile
  tab is a real summary (identity, voice/language/speech, wake word, push-to-talk,
  accent) with quick actions that patch settings. Bundled by
  `scripts/bundle-renderer.mjs` with
  esbuild into a deferred classic script, because Chromium refuses `file://`
  ES-module imports.
- Typography: `src/renderer/theme.css` self-hosts two variable fonts — `Space
  Grotesk` (display) and `Public Sans` (body), each split into latin /
  latin-ext subsets with `unicode-range` — so the UI reads as a deliberate,
  non-generic product rather than a default sans stack. There is no network
  font fetch at runtime; the `.woff2` files ship in the renderer bundle.
- `electron-platform.ts`, `main.ts`, `preload.ts` are the only files that
  import `electron`; everything under `src/shell/` is dependency-free.
- `orb/` — the floating presence. `window-options.ts` holds the frameless /
  transparent / non-activating-panel options; `placement` (in `src/shell/`)
  anchors it to the upper-right of the work area (centre at
  `ORB_VERTICAL_CENTER_FRACTION = 0.25`, nudged right by
  `ORB_RIGHT_SHIFT_FRACTION` past `ORB_RIGHT_MARGIN`) against an injected
  `ScreenProvider`. The window is larger than the painted circle so the glow can
  fall off; the clamp is against the circle, not the window, so the transparent
  padding may overhang the edge while the visible Orb stays on screen. The
  renderer (`orb/renderer/orb.ts`, `src/renderer/orb.html`) draws exactly one
  circle — a radial shader face, a glow, a conic status ring, a breathing core,
  a moving sheen and orbiting motes — and keeps the window click-through except
  inside that circle via the `orbSetInteractive` channel and the pure
  `orb/hit-test.ts`. The face is the `exprmntl/orb-ui` radial theme: the exact
  GLSL fragment shader and the upstream motion recipe live in
  `orb/renderer/radial.ts` (`RADIAL_ULTRA` is that theme with every motion knob
  pushed past the stock "expressive" preset, hence "ultra strong"). `radial.ts`
  is pure and DOM-free apart from `createRadialRenderer`, so the motion math
  (`radialMotionFor`, `radialRotationTarget`, `followDuration`) is unit-tested
  without a GL context. `orb/renderer/orb.ts` drives the shader from the
  presence: energy follows the state, speed and the calm oscillators ease toward
  their per-state targets, and a spring carries one rotation position and
  velocity across state changes. Aria's twelve presences fold into the radial
  theme's six states through `RADIAL_STATE`; the CSS `conic-gradient` face is the
  fallback when WebGL is unavailable (jsdom, a blocked GPU), so the sphere is
  never a flat disc. The circle is a real control: a click or `Enter`/Space on it
  opens the chat window (`aria.openChat`), hover lifts and presses the sphere,
  and the animations stand down under `prefers-reduced-motion`.
  `orb/backdrop.ts` plans a full-screen material
  (macOS vibrancy, Windows acrylic) and honestly reports unsupported on Linux
  rather than faking a blur with an opaque rectangle. `state.ts` defines
  `OrbPresence` — the All-Knowledge §7.3 conceptual states, reusing the repo's
  existing lifecycle names where they already matched (`idle`/`listening`/
  `thinking`/`speaking`/`error`/`muted`); the canonical extras are `hidden`,
  `interrupted`, `awaiting_approval`, `awaiting_input`, `task_running`,
  `recovering`. `OrbService.buildState` reports `hidden` when `orbVisible()` is
  false, so no animation claims the Orb is present when it is not. `assemble.ts`
  (`resolvePresence`, `taskPresence`) maps live signals — pending plans or
  permissions → approval, pending questions → input, a cancelled voice session →
  interrupted — to a state plus a non-color cue; `orb-service.ts`'s
  `summarizeTask` picks the highest-priority phase across supervisor records.

Brand: `build/icon.png` (the `.deb` icon) and `src/renderer/logo.png` (the
in-app mark) are the same shipped brand image, generated square from the source
artwork. The Control Center brand mark (`brandMark` in `control-center.ts`) and
the chat empty-state hero both render it as an `<img>` (`./logo.png`) rather
than a second hand-drawn SVG, so the logo has one source of truth. That needs
`img-src 'self'` in the `control-center.html` / `chat.html` CSP; the orb window
ships no image and keeps `default-src 'none'` with no `img-src`.

Test baseline: 793 tests / 79 files. `src/shell/testing/doubles.ts` holds
`FakePlatform`, `FakeWindowFactory`, `FakeWindowHandle`, `FakeScreenProvider`,
`FakeKeyListener`, `FakeShortcutRegistration`, `FakeShellRuntime`,
`FakeVoiceRuntime`.

## Account and sign-in (`src/auth/`)

Sign-in is a browser device-code flow against the Beyonders account surface.

- `device-login.ts` (`DeviceLoginClient`) — `requestCode(fingerprintId)` opens a
  code at `/api/auth/cli/code`; `poll` reads the status endpoint until the
  account is linked, the server-provided deadline passes, or the caller aborts.
  Time and sleep are injectable so the loop is deterministic in tests. A
  transport failure is a classified `transport` result, never a throw.
- `fingerprint.ts` — a stable machine fingerprint id/hash used to bind the code.
- `credential-store.ts` (`CredentialStore`) — the durable credential at
  `~/.config/aria/credentials.json` (honouring `ARIA_CONFIG_DIR` /
  `XDG_CONFIG_HOME`), in the Directioner CLI's own shape
  (`{ default: { …, authToken } }`). It prefers Aria's own file, falls back to an
  existing CLI login, preserves unrelated profiles, writes atomically, and clamps
  the file to `0600` on every read and write.
- `account.ts` (`AccountManager`) — `restore`/`beginLogin`/`awaitLogin`/`clear`.
  `awaitLogin` persists the credential on success and maps a timeout/abort to a
  classified failure.
- `AriaRuntime` owns an `AccountManager`; `beginLogin`/`awaitLogin`/`cancelLogin`
  and `signOut`/`setSessionToken` invalidate the session-scoped reads. The
  Control Center Account tab and the `accountBeginLogin`/`accountAwaitLogin`/
  `accountCancelLogin` IPC channels drive it.

## Caching (`src/cache/`)

`async-cache.ts` (`AsyncCache`) is a TTL cache with single-flight de-duplication:
a value read within its lifetime is served from memory, and concurrent misses for
one key share a single producer call. Only successful results are cached, so a
transient failure is retried rather than pinned. `AriaRuntime` routes
`capabilities()` and memoises identity through it, invalidating on a session
change.

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
  the Backend before rendering so the surface shows current truth. Overlapping
  `buildState` calls share one reconcile (`reconcileOnce`): the surface polls on
  an interval, and without de-duplication a backend slower than the interval
  stacks a fresh reconcile — and its backend round-trips — on every tick, which
  is what made the window feel laggy. `recordViews` fetches each task's approvals
  concurrently.
- `submission.ts` — the pure policy for the above: `shouldSubmit(route)`,
  `deriveTitle(text)` (the user's own words, bounded), and
  `operationForRoute(route)` (describes only the capability the hint carried;
  Aria never fabricates privileges, resources or risk).
- `chat-runtime.ts` (`createChatRuntime`) — adapts `AriaRuntime` to the
  `ChatRuntime` seam: `tasks.submit` calls `supervisor.submitRequest` then reads
  back the opened approval; `rememberApproval` is async and must be awaited
  before `approvalScope` will resolve.
- `state.ts` / `assemble.ts` — the `ChatState` the renderer consumes.
- `renderer/chat.ts` (`renderChat`, `bootstrapChat`) — the chat UI, styled by
  `src/renderer/chat.css`. It renders conversation turns (user/assistant, with
  rich text: headings, lists, code, links), permission and approval/result
  blocks, and a composer. Submitting paints the user turn and a pending reply
  optimistically before the round-trip; while a reply is pending the composer
  also offers a stop control wired to `interruptSpeech` (barge-in, never a task
  cancellation). Enter sends, Shift+Enter inserts a newline, Escape clears. The
  renderer keeps the caret and scroll position across repaints so a live update
  does not yank the user out of the box.

## Stop, cancellation, and recovery (`src/control/`, `src/backend/`)

Honest stopping and outage handling. Nothing is reported stopped, completed, or
recovered unless it was observed to reach that state.

- `control/cancellation.ts` — `confirmCancellation` requests a stop and waits
  for the authoritative execution state to reach `cancelled` within a grace
  period. Only then is it `confirmed`; a terminal-but-not-cancelled task is
  `not_cancellable`; a stop that never lands is `failed` with a reason.
  `describeCancellation` renders the honest line.
- `control/mute.ts` — `MuteController` owns the local mute flag and the capture
  mode it would resume. `mayCapture` refuses while muted.
- `control/stop-controller.ts` — `StopController` engages the local halt
  synchronously and reports what the local layer actually did.
- `backend/backend-outcome.ts` — `classifyBackendOutcome` splits failures into
  `definite_rejection`, `unavailable`, and `uncertain`; `availabilityFromOutcome`
  maps them to `online`/`offline`/`unauthenticated`/`unknown`.
- `backend/retry.ts` — `retryIdempotent` retries only `unavailable`/`uncertain`,
  bounded by `MAX_ATTEMPTS`, reusing one idempotency key so a retried write
  cannot double-apply.
- The supervisor exposes `availability`, `observeBackendOutcome`, `recover`,
  `reconcileUncertain`, `reconcileExecutions`, and `cancelAndConfirm`. New
  tracked work is refused while the Backend was last observed offline (fail
  closed); the emergency stop stays local and works offline.

The chat surface (`ChatService.muteCapture`/`interruptSpeech`/`stopPlayback`,
the renderer's emergency controls, and the `muteCapture`/`interruptSpeech` IPC
channels) drives these through `ChatControl`. See `docs/RECOVERY.md`.

## Backend errors

`AriaBackendError` (`src/backend/product-errors.ts`) carries `kind`, an
optional `requestId`/`retryAfterSecs`, and — for response failures — the HTTP
`status`, so a caller can distinguish a provider failure (502) from a backend
outage (503) without re-deriving it from the kind.

`backend/user-facing.ts` is the only place a backend failure becomes text a
person reads. `userFacingMessageForKind` maps each `AriaErrorKind` to a fixed
plain sentence; an unrecognized kind degrades to a generic connectivity line,
never the kind string. `redactUserDetail` scrubs a free-form detail string of
hosts, URLs, bare IPs, bearer/JWT credentials and email addresses before it is
shown in a diagnostic or incident, so raw backend detail cannot leak through a
log line the user can read. Callers (`control-center-service.ts`,
`control-center-runtime.ts`) pass detail through it rather than rendering it.

## Security posture

`shell/security.ts` is the single source of the renderer hardening policy.

- `RENDERER_WEB_PREFERENCES` runs every window with `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`, no webview, no
  devtools and `safeDialogs`. `main.ts` also calls `app.enableSandbox()` so a
  window created without explicit preferences still cannot run unsandboxed.
- `applyWebContentsHardening(webContents)` installs, per webContents: navigation
  and redirect cancelled unless the URL is an app `file://` page, a
  `setWindowOpenHandler` that denies every popup with no shell fallback, and a
  `will-attach-webview` that denies. It is applied in `electron-platform.ts` at
  window creation and again in `main.ts` from `app.on('web-contents-created')`,
  so it holds for any window the app ever creates.
- `applySessionHardening(session)` installs the session-scoped policy once, in
  `main.ts`, before any window exists: every remote request a renderer makes
  (`http`/`https`/`ws`/`wss`/`ftp`) is cancelled by `webRequest.onBeforeRequest`
  — the renderer has no network business, and the backend is reached only from
  the main process via `FetchTransport` (`fetch`), which is unaffected. It also
  grants only the microphone, and only to a main frame on an app page, and
  denies device (HID/USB/serial) and screen-capture outright. `clearSessionStorage`
  runs on `will-quit`.
- The preload is bundled by `scripts/bundle-renderer.mjs` to a single
  `dist/preload.cjs` that only `require`s `electron`, so it runs inside the
  sandbox without a module loader. The context bridge is fixed at build time;
  `shell/ipc.ts` exposes only `BRIDGE_METHODS` and never a token or raw
  `ipcRenderer`.
- `registerIpcHandlers` (`shell/ipc-handlers.ts`) wraps every channel with
  `isTrustedSender`: a handler refuses a message whose `senderFrame.url` is not
  an app page, so a privileged handler never acts on an untrusted frame.

## Packaging integrity

- Electron fuses are set in `package.json` (`build.electronFuses`): `runAsNode`,
  `enableNodeOptionsEnvironmentVariable`, `enableNodeCliInspectArguments` and
  `grantFileProtocolExtraPrivileges` are disabled; `enableCookieEncryption`,
  `enableEmbeddedAsarIntegrityValidation` and `onlyLoadAppFromAsar` are enabled.
  `loadBrowserProcessSpecificV8Snapshot` is left off on purpose — Electron's
  prebuilt Linux binary ships no browser-specific snapshot, so enabling it makes
  the app abort at boot with "Error loading V8 startup snapshot file".
- The shipped asar must carry no reverse-engineering surface. `tsconfig.json`
  builds with `sourceMap: false`; `tsconfig.build.json` excludes tests and the
  preload; `scripts/clean-dist.mjs` wipes `dist` before every build;
  `scripts/copy-renderer.mjs` prunes any stray `.ts`/`.map` from the copied
  renderer; and `build.files` excludes `*.map` and `*.d.ts`. Renderer bundles are
  minified. `scripts/verify-package.mjs` asserts the packaged asar has no maps,
  declarations or test sources, and `npm run smoke:deb` runs it before the boot
  smoke test.
- `scripts/smoke-deb.mjs` observes boot liveness over real time: a process that
  crashes on start exits before the first poll, so the old synchronous check
  could report a boot that never happened.
- `build.deb.afterInstall` (`build/linux/after-install.sh`) and
  `build.deb.afterRemove` (`build/linux/after-remove.sh`) **replace**
  electron-builder's default maintainer scripts wholesale, so each must
  reproduce every step the default template performs. Dropping a step ships a
  broken package that no unit test sees. Two such omissions reached users:
  without `update-alternatives` the package installed `/opt/Aria/aria-desktop`
  but never put it on `PATH` (`aria-desktop: command not found`), and without
  the sandbox step Chromium aborted at launch on hosts with no unprivileged user
  namespace. The scripts now carry the launcher link, the sandbox mode
  (`chmod 4755` when `unshare --user` fails), the desktop/MIME cache refresh and
  the AppArmor profile; `after-remove.sh` undoes the link and profile.
  `src/packaging/deb-scripts.test.ts` guards the steps, and the release workflow
  installs the deb with `apt` and asserts `/usr/bin/aria-desktop` exists before
  booting it. Verify a change here by extracting `control.tar.xz` from the built
  deb and reading `postinst`/`postrm`.
