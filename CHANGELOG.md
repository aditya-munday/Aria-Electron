# Changelog

All notable changes to Aria-Electron are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions use
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Entries before
`0.3.0` predate this file and are tracked only by tag.

## [0.7.1] - 2026-10-14

### Fixed
- An in-place upgrade now ends a running Aria before the new files land
  (`build/linux/after-install.sh`, wired as `build.deb.afterInstall`). The app
  takes a single-instance lock, and the previous release stayed resident with a
  system tray, so a freshly installed 0.7.0 handed focus to the still-running
  0.6.1 process: the user kept seeing the old Control Center and the old tray
  until they logged out. The post-install step removes that stale instance so
  the next launch starts the new version.

## [0.7.0] - 2026-10-14

### Added
- The Orb is the `exprmntl/orb-ui` radial theme, "ultra strong". The exact
  upstream GLSL fragment shader, motion recipe and six-state model live in
  `src/orb/renderer/radial.ts`; `RADIAL_ULTRA` pushes every motion knob past the
  upstream "expressive" preset so the presence reads as forceful rather than
  polite. Aria's twelve presences fold onto the six states, and the CSS conic
  face is the fallback when WebGL is unavailable.
- Wake word runs on-device through VoxRT (`@voxrt/wake-word-browser`): a
  WebAssembly runtime plus a trained "Hey Assistant" model, with no network, no
  API key and no native build. The renderer owns the microphone and reports a
  detection back to the runtime, which runs the same activation path as the
  local listener.
- The brand mark is the shipped logo (`build/icon.png`, `src/renderer/logo.png`)
  rendered as an image in the Control Center header and the chat empty-state
  hero, so the logo has one source of truth.

### Changed
- Aria has no system tray. Closing a window only hides it and the process stays
  resident; quitting is an explicit Control Center action that warns it stops
  wake-word listening and the global shortcuts.

### Removed
- The system tray icon, its menu, and the `tray-icon.ts` embedded PNG.

## [0.6.1] - 2026-10-14

### Fixed
- The chat surface is text-only. A typed/chat turn no longer opens the live
  TTS stream: `VoiceSession.runText()` sets `speakEnabled = false`, so `deliver()`
  returns before `speak()` is reached, and the chat reply is rendered without
  playback. The Orb is raised only for a voice turn (`source !== 'text'`), so
  typing a message no longer animates the presence as if Aria were speaking.
  Voice turns are unchanged: they still synthesize and play.

## [0.5.0] - 2026-10-11

### Added
- Sign in with a Beyonders account through the browser device-code flow
  (`src/auth/`): `DeviceLoginClient` requests a code, opens the login URL, and
  polls the status endpoint until the account is linked. The credential is
  persisted to `~/.config/aria/credentials.json` in the Directioner CLI's own
  shape (`{ default: { …, authToken } }`), so an existing CLI login is picked up
  for free; the file is owner-only (`0600`) and re-tightened on every read and
  write. The Control Center Account tab, `AccountManager`, and the
  `accountBeginLogin`/`accountAwaitLogin`/`accountCancelLogin` IPC channels are
  wired end to end.
- A TTL + single-flight cache (`src/cache/async-cache.ts`) behind capabilities
  and identity reads, so a renderer refresh or a burst of callers no longer
  re-fetches the same backend resource. Only successful results are cached, and
  a sign-in/sign-out invalidates the reads that depend on the session.

### Fixed
- The chat window no longer lags. `AriaSupervisor.refresh` reads a task's
  execution and journal concurrently instead of in series, `reconcile` refreshes
  tracked tasks in parallel rather than one at a time, and `ChatService`
  collapses overlapping reconciliations (and `bootstrapChat` overlapping polls)
  into a single in-flight pass — so a backend slower than the poll interval no
  longer stacks concurrent reads and repaints on every tick.
- The Control Center Account copy names no backend or product vocabulary; the
  sign-in control reads "Sign in" and explains that Aria opens the browser.

### Changed
- Test suite grows from 722 to 757 tests; adds coverage for the auth layer
  (`device-login`, `account`, `credential-store`), the cache, and the
  reconcile/poll de-duplication.
- `AGENTS.md` documents the auth, cache, and chat-latency behaviour.

## [0.4.0] - 2026-10-11

### Fixed
- The tray push-to-talk label now reflects the runtime's real capture state
  (`AriaShell.setPushToTalkActive`, fed from the voice runtime's `session.state`)
  instead of the shell's local tap bookkeeping. A capture that ends on its own —
  VAD silence, an empty or too-short utterance, the max-duration cut-off, or a
  failure — no longer leaves the tray offering "Stop listening", and the next tap
  starts a fresh capture rather than sending a release for a finished one.
- `isOrbPresence` and `userFacingMessageForKind` now test own properties
  (`Object.hasOwn`) rather than the `in` operator, so an inherited key such as
  `toString` or `constructor` is no longer accepted as a real Orb presence or
  error kind.
- The `/v1` client redacts a credential-shaped message on a classified backend
  error, so the Aria surface and the product surface cannot disagree on what is
  safe to surface or log.
- Settings are persisted atomically (write a sibling, then rename) with
  owner-only (`0600`) permissions, so a crash mid-write can no longer truncate
  `shell-settings.json` into a file the next load silently reads as defaults.

### Added
- Tests for previously uncovered behaviour: `backend/result`,
  `backend/product-errors`, `backend/user-facing` (prototype-key case),
  `backend/aria-client` (error redaction), `chat/assemble`,
  `contract/aria-contract`, `shell/geometry`, `shell/settings-file`,
  `orb/state`, `supervisor/task-store`, `voice/errors`, and the shell
  tray-capture lifecycle. Suite grows from 672 to 722 tests.

### Changed
- README gains release and latest-version badges.
- `AGENTS.md` test baseline updated to 722 tests / 72 files.

## [0.3.0] - 2026-10-13

### Fixed
- The tray push-to-talk control now drives the same `activatePushToTalk` path
  as the global accelerator. Previously a tray tap in `hold` mode sent a press
  immediately followed by a release — a zero-length hold the controller rejects
  — and in `toggle` mode the second tap sent a release the toggle controller
  ignores, so capture could not be stopped. A tap now starts a capture and the
  next tap stops it, in either mode.
- The tray menu is refreshed when shortcuts change, so the push-to-talk item
  reflects the requested state instead of going stale.
- A capture held from the tray is released when push-to-talk is disabled, so
  the microphone is never left open.

### Changed
- Removed the dead `AriaShell.environment()` method (no callers; the interaction
  router owns the real environment).
- The README configuration table documents the real `ARIA_*` variables
  (`ARIA_BACKEND_URL`, `ARIA_REQUEST_TIMEOUT_MS`, …) with the default backend
  `https://api.adityamunday.codes`; the module map reflects the shipped app.
- `AGENTS.md` test baseline updated to 672 tests / 63 files.

## [0.2.0]

- Chat renderer overhaul, resilient push-to-talk grabs, interactive Orb and a
  polished Control Center (tag `aria-v0.2.0`).

## [0.1.5]

- Release tooling: pick the highest version, verify downloads, describe the
  release (tag `aria-v0.1.5`).

## [0.1.2] – [0.1.4]

- Early package builds (tags `aria-v0.1.2` … `aria-v0.1.4`).

[0.3.0]: https://github.com/aditya-munday/Aria-Electron/releases/tag/aria-v0.3.0
[0.4.0]: https://github.com/aditya-munday/Aria-Electron/releases/tag/aria-v0.4.0
[0.6.1]: https://github.com/aditya-munday/Aria-Electron/releases/tag/aria-v0.6.1
[0.7.0]: https://github.com/aditya-munday/Aria-Electron/releases/tag/aria-v0.7.0
