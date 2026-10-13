# Changelog

All notable changes to Aria-Electron are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions use
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Entries before
`0.3.0` predate this file and are tracked only by tag.

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
