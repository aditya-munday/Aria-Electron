# Changelog

All notable changes to Aria-Electron are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions use
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Entries before
`0.3.0` predate this file and are tracked only by tag.

## [Unreleased]

### Added
- The **Python voice sidecar** (`sidecar/`, package `aria-voice 0.8.0`):
  openWakeWord wake detection and Silero VAD in a separate process, so a
  native/model fault cannot take down the app (the 0.7.6 crash mode). Framed
  stdio protocol, bounded frame reader, model validation, compute-provider
  auto-selection, and a calibration helper. Opt-in via
  `ARIA_WAKE_ENGINE=sidecar`; the dependency-free JS detector stays the default.
- The Electron integration for the sidecar: `sidecar-supervisor.ts` (ready
  handshake, protocol-version check, bounded-backoff restart, clean shutdown),
  `sidecar-wake-detector.ts` (the `WakeWordEngine` adapter), `sidecar-protocol.ts`
  (the TS mirror of the wire protocol, every event validated with zod), and
  `sidecar-path.ts` (executable resolution).
- `docs/VOICE_SIDECAR.md` (process contract and wire protocol) and
  `docs/WAKE_WORD.md` (shipped wake defaults, measured false-accept target,
  calibration). A `ci.yml` workflow runs the TypeScript and Python gates,
  including `bench/eval_wake.py` as a false-accept regression gate.
- The sidecar is packaged into the Debian package as a self-contained
  PyInstaller executable (`scripts/build-sidecar.mjs`, `sidecar/aria-voice.spec`)
  and staged under `resources/sidecar/aria-voice/`. `verify:package` checks it
  against the recorded checksum, and the postinst makes it root-owned and
  executable and stops a stale instance on upgrade.

### Security
- The renderer pages are served from a privileged, secure `app://aria` scheme
  instead of `file://`, so Electron's `grantFileProtocolExtraPrivileges` fuse is
  now off (it was on, contradicting the documented hardening). `isAppUrl` only
  trusts the app's own origin, and the protocol handler refuses a foreign host or
  a path that escapes the renderer root. `scripts/security-check.mjs` now fails
  if any required fuse is flipped, so this cannot silently regress.
- `normalizeBaseUrl` rejects plaintext `http` to any host but loopback, so a
  bearer token cannot be sent in the clear.
- Runtime and toolchain dependencies are pinned to exact versions.
- The wake word and start-on-login are now opt-in (both default off): a fresh
  install opens no microphone and writes no autostart entry before consent.

### Changed
- Push-to-talk no longer looks like it "asks for the wake word". The resting Orb
  advertised wake listening even with the wake word off; it now shows the
  wake-listening presence only while detection is enabled, and the Control
  Center states plainly that the global accelerator is a tap (`Super+Alt+T`).
- Graphics acceleration probes render nodes `renderD128`-`renderD135`, card
  nodes and NVIDIA control nodes, honours the `ARIA_GRAPHICS=auto|on|off`
  setting, detects the X11/Wayland session and sets the Ozone platform hint, and
  logs Chromium's GPU feature status at startup.
- The Assistant configuration "Model" row now says the model is client-reported
  (the service does not advertise one) instead of claiming it is fixed.
- Corrected the configuration docs: `ARIA_SESSION_TOKEN` is held in memory and
  never written to disk, but a device-code sign-in does persist one owner-only
  (`0600`) credential at `~/.config/aria/credentials.json`. The README table now
  lists `ARIA_LOGIN_URL`, `ARIA_CONFIG_DIR`, `ARIA_FINGERPRINT_PATH`,
  `ARIA_ENABLE_GPU`/`ARIA_DISABLE_GPU`, `ARIA_WAKE_ENGINE`, `ARIA_GRAPHICS` and
  `ARIA_OZONE`.
- Aligned the documented push-to-talk vocabulary and typography with the code
  (`Super+Alt+T` global tap, focused `F5` hold; `Inter`), and the test baseline.

### Added
- `AUDIT.md` (Phase 0 deep audit), `LICENSE` (placeholder) and
  `THIRD_PARTY_NOTICES.md`; `wakewordmodel/` is now gitignored.

## [0.7.7] - 2026-10-16

### Fixed
- The wake word and push-to-talk no longer stop working after a single
  transient microphone error. The hidden voice renderer reports a capture
  error whenever `getUserMedia` throws once — a busy device, a dismissed
  permission prompt, or a hiccup while the audio graph starts. The microphone
  adapter latched that error into a permanent `denied` permission and an empty
  device list, and both capture paths check permission before they open the
  stream, so after one such error the wake-word listener and every
  push-to-talk session aborted with `permission_denied` and never retried.
  With both features enabled by default, this presented as the wake word
  simply not working. A capture error is now treated as transient: the adapter
  reports permission as granted (the app-level `media` permission is already
  granted to the app's own frames) and lets the capture attempt itself report a
  genuinely unavailable device.
- A wake-word error no longer lingers once listening recovers. The Orb rendered
  the last capture error as an error presence, so a listener that recovered
  after a device appeared or permission was granted still showed a failure that
  no longer existed. The runtime now clears a stale capture error when the
  listener starts successfully.
- Device-code sign-in now mirrors the Directioner CLI's wire contract exactly
  and reports the backend's own failure instead of a generic one. The
  `/api/auth/cli/*` endpoints are unversioned and the client no longer sends an
  `Authorization` header on them; `expiresAt` is echoed to the status endpoint
  byte-for-byte (it is the HMAC input the server verifies) and the poll deadline
  is taken from the server's `expiresInMs` duration, so a skewed client clock
  cannot cut a valid code short. A `503` from an unconfigured deployment is now
  surfaced verbatim, with its request id, as "sign-in is not available" rather
  than being collapsed into a retry loop; `410` is reported as an expired code,
  and `429` is backed off with jitter, honouring `Retry-After`. The device
  fingerprint is a persisted installation id (not a host-derived hash that
  drifts), so a login approved in the browser is no longer lost when the value
  changes mid-flow.

## [0.7.6] - 2026-10-15

### Fixed
- The app no longer crashes at launch on a host with a working microphone.
  Wake-word detection was on by default and its engine, the VoxRT WebAssembly
  runtime, ran in the *main* process. Native code there cannot be trapped: a
  fault in it (an unsupported CPU feature, a bad model, a hostile audio frame)
  killed the whole process with SIGSEGV before any window appeared — with or
  without the GPU, which is why 0.7.5's software fallback did not help. The
  default detector is now the dependency-free JavaScript phrase spotter
  (`wake-phrase-engine.ts`), which runs in V8's sandbox and can never take the
  process down. VoxRT is still available, but only opt-in, via
  `ARIA_WAKE_ENGINE=voxrt`.
- The JavaScript detector now recognises the shipped default phrase
  ("Hey Assistant"). Its voiced-fraction gate was tuned for vowel-heavy phrases
  and rejected the fricative-heavy default, so the wake word would have matched
  nothing even when the engine loaded cleanly.

## [0.7.5] - 2026-10-15

### Fixed
- The app no longer crashes at launch on a host whose GPU stack is
  half-present. Chromium's GPU initialisation failed (`vaInitialize failed`,
  `MESA-LOADER: failed to open dri`) and the process died with SIGSEGV before
  any window appeared. Hardware acceleration is now enabled only when a readable
  DRM render node exists; otherwise the app renders in software. A run that
  crashed while using the GPU is recorded on disk and the next launch backs off
  to software on its own, so an affected machine recovers without a rebuild.
  `ARIA_ENABLE_GPU` / `ARIA_DISABLE_GPU` override the decision.

## [0.7.4] - 2026-10-15

### Fixed
- Installing the `.deb` now creates the `aria-desktop` launcher. Setting a
  custom `afterInstall` replaces electron-builder's default postinst wholesale,
  and the script had dropped the default template's `update-alternatives` step,
  so the package installed `/opt/Aria/aria-desktop` but never put it on `PATH`.
  The shell reported `aria-desktop: command not found`, and launching from the
  desktop icon would also have failed. The script now reproduces every default
  step: the launcher link, the desktop/MIME caches and the AppArmor profile.
- Added a matching `afterRemove` (`build/linux/after-remove.sh`) so uninstalling
  removes the launcher link and the AppArmor profile instead of leaving them
  behind.

## [0.7.3] - 2026-10-15

### Fixed
- The `.deb` sets the `chrome-sandbox` helper mode on install. A custom
  `afterInstall` script replaces electron-builder's default template wholesale,
  and the previous script omitted the template's sandbox step, so the helper was
  left mode 0755. On a host whose kernel refuses an unprivileged user namespace
  (Debian 13, Ubuntu 24+ with the AppArmor userns restriction) Chromium then
  aborts at launch — the app never opens, so wake word could never run. The
  script now mirrors the template (`chmod 4755` when `unshare --user` fails).
- Wake word ("Hey Assistant") now works in the shipped `.deb` on a stock host.
  Capture used to require an external command-line recorder
  (`parec`/`arecord`/`pw-record`), which a plain install does not have, so the
  wake listener stood down and the microphone was inert. The microphone is now
  owned by a hidden renderer: `getUserMedia` needs no external tool and works on
  any Electron host, so the VoxRT detector and every voice session run on real
  audio with nothing else installed.
- A capture command that raced the hidden renderer's subscription is no longer
  lost. The renderer reports `idle` when it loads and the main process re-sends
  `start` on every `idle` while it wants the microphone, so a start issued before
  the renderer was ready still begins capture.
- A `stop` that arrives while the device is opening no longer leaves a stale
  capture or a pending start that hangs to the timeout: the stale start is
  abandoned (and its device released) and the pending start fails fast. A partial
  frame left over from a stopped capture is dropped so it cannot bleed into the
  next one.

### Added
- `RendererMicrophone` (`src/voice/renderer-microphone.ts`) drives the hidden
  renderer over IPC (`aria:voice:capture-{start,stop,pcm,status}`) and presents
  it to the runtime as an ordinary `Microphone`, so detection, the confidence
  floor and the cooldown stay in the main process.
- `VoiceCapture` (`src/voice/renderer/voice.ts`, bundled to
  `dist/renderer/voice.js`) captures 16 kHz mono PCM in the hidden `voice` window
  and streams it back; `src/renderer/voice.html` loads it. The window is created
  hidden by `AriaShell.ensureVoiceWindow()`, never shown, never persisted, and
  runs with `backgroundThrottling: false`.

## [0.7.2] - 2026-10-14

### Fixed
- The Orb no longer rebuilds its DOM and creates a fresh WebGL context on every
  presence poll. `bootstrapOrb` keyed its "did anything change" check on
  `JSON.stringify(state.presence)`, but `presence.updatedAt` is a new timestamp
  on every read, so the key never matched: the shader was torn down and a new
  context allocated about twice a second, which is what made the app stutter and
  eventually crash once the browser's context budget ran out. The key now
  excludes `updatedAt` (the same reason the chat surface strips `generatedAt`),
  and a presence change updates the existing sphere in place instead of
  rebuilding it. A hidden presence now paints nothing and stops the shader.

### Changed
- The interface adopts the Beyonders scheme: violet accent (`#a78bfa`), basalt
  surfaces (`#0f0f0f` … `#202020`) and the Inter typeface, replacing the previous
  indigo/Space Grotesk theme. Every token name is preserved, so the Control
  Center and Chat render against the new palette without markup changes.
- An additive motion layer (animated accents, glass, gradient text, hover lift,
  sheen) is available to both surfaces. It animates only
  `transform`/`opacity`/`box-shadow`, so the compositor carries it, and it is
  fully disabled under `prefers-reduced-motion` or `html[data-motion='reduced']`.

### Added
- The app has sound. Cues are synthesised with the Web Audio API (no audio
  assets, no network, no CSP change) and fire on send, receive, notify, start,
  stop, error, toggle and confirm. The chat surface diffs consecutive states so
  a new reply, a new task, a task that finishes and an emergency stop each read
  as a distinct sound; the Control Center sounds sign-in start/success/failure.
  The layer is silent when muted, inert without an `AudioContext`, and throttles
  repeated cues.

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

## [0.3.0] - 2026-10-10

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
