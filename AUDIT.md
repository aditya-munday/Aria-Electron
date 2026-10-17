# AUDIT.md — Aria-Electron 0.7.7 deep audit

Phase 0 of the master engineering prompt. Every finding below was reproduced
against the working tree at commit `b5473d8` (v0.7.7) unless stated otherwise.
Evidence is a command, a file:line, or a quoted source line — not a guess.

## Baseline (all green before any change)

| Gate | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | exit 0 |
| Tests | `npm test` | 86 files / 876 tests passed |
| Security | `npm run security:check` | ok (electron 44.7.0, prod deps clean, CSP intact) |
| Audit (prod) | `npm audit --omit=dev` | 0 vulnerabilities |
| Audit (all) | `npm audit` | 8 moderate (all devDependency/build-tool chain) |

`npm ci`, `npm run build` and `npm run smoke:deb` require network/apt/root and a
display; they were not run in this environment. `npm run build` was exercised
indirectly (the dist tree is present and `tsc` is clean).

## Suspected issues — confirmed / refuted

### S1 [High] Electron fuse mismatch — CONFIRMED

- `package.json` `build.electronFuses.grantFileProtocolExtraPrivileges: true`.
- `AGENTS.md:739` claims `grantFileProtocolExtraPrivileges` is **disabled**.
- The renderers are loaded with `loadFile` (`src/electron-platform.ts:101,109`),
  i.e. `file://`, and `isAppUrl` is literally `url.startsWith('file://')`
  (`src/shell/security.ts:71`).
- Root cause: `file://` is the app's page scheme, and with the fuse off Electron
  refuses `file://` pages the extra privileges they need; the flag was left on to
  keep the app loading. `scripts/security-check.mjs` does not check any fuse, so
  the regression is unguarded.
- Fix: register a privileged custom scheme (`app://`) before `ready`, serve the
  renderer from it via `protocol.handle`, move the fuse to `false`, update
  `isAppUrl`/navigation allow-lists/trusted-sender to the new origin, and make
  `security-check.mjs` fail if any fuse regresses. Status: **fixed (Phase 1)**.

### S2 [High] Token persistence claim — CONFIRMED

- `README.md:91,93`: the session token is "held in memory and never written to
  disk".
- `src/auth/credential-store.ts` persists `authToken` in plaintext JSON at
  `~/.config/aria/credentials.json` (0600). The claim is false.
- Root cause: two different things are conflated — the *in-memory* session token
  seeded by `ARIA_SESSION_TOKEN`, and the *durable* device-login credential. Only
  the latter is written.
- Fix: correct the README/AGENTS wording to describe both truthfully; keep the
  credential file 0600 and CLI-interop read-only. safeStorage (libsecret/kwallet)
  is a larger change with a user-visible degraded mode; recorded as P2 follow-up.
  Status: **docs fixed (Phase 1); safeStorage deferred (P2)**.

### S3 [High] Wake detector design — CONFIRMED

- Default engine is the JS spectral-DTW matcher (`src/voice/wake-phrase-engine.ts`
  vs synthetic `formant-synth.ts` templates; selected in `voice-runtime.ts:602`
  when `ARIA_WAKE_ENGINE` is unset). Templates are synthetic, not trained.
- Root cause of "wake word not working" beyond the 0.7.x capture bugs. Addressed
  by the Phase 2 openWakeWord sidecar; the JS spotter becomes an explicitly
  labelled last-resort fallback. Status: **Phase 2**.

### S4 [Med-High] Push-to-talk spec drift — CONFIRMED

- `AGENTS.md:356` "hold the `F5` key"; `AGENTS.md:382` "`Win + Alt + A`".
- Code: `PUSH_TO_TALK_ACCELERATOR = 'Super+Alt+T'` (`src/shell/window.ts`), chat
  is `Super+Alt+A`; `F5` is a *focused-window* key (`src/shell/window.ts:16`,
  `pushToTalk: 'f5'`), not global. "Win" is wrong vocabulary on Linux.
- Fix: align AGENTS/README to the real model (global `Super+Alt+T` tap, focused
  `F5` hold), Linux wording. Status: **docs fixed (Phase 1)**.

### S5 [Med] Orb click-through on Linux — CONFIRMED (partly)

- `src/shell/aria-shell.ts:467` uses `setIgnoreMouseEvents(!interactive, { forward: true })`.
- Electron documents `forward` as **macOS/Windows only**; on Linux the window may
  never receive `mouse-move`, so `orbSetInteractive` (the `mousemove` re-evaluate
  at `src/orb/renderer/orb.ts:382`) can fail to make the circle clickable.
- Root cause: relying on a `forward` option Linux does not implement.
- Fix: a polling-free input-shape alternative (or verify the hit-test path and
  document the Linux behaviour); test the hit-test. Status: **Phase 4** (needs a
  display to verify; the pure hit-test is unit-testable now).

### S6 [Med] Privacy defaults — CONFIRMED

- Wake word and start-on-login default on (always-on mic + autostart, no consent).
- Fix: first-run onboarding; both opt-in; visible capture indicator. Status:
  **Phase 4**.

### S7 [Med] Doc/config drift — CONFIRMED

- Typography: `AGENTS.md:531` says `Space Grotesk`/`Public Sans`; the shipped
  theme is `Inter` (`src/renderer/theme.css:19`, and `AGENTS.md:106` says Inter).
- Push-to-talk drift (see S4).
- CHANGELOG dates out of order: `0.5.0`/`0.4.0` dated 2026-10-11 appear *after*
  `0.3.0` dated 2026-10-13 (`CHANGELOG.md:204,237,269`).
- Stale baseline: `AGENTS.md:586` "793 tests / 79 files" vs the real 876/86.
- External refs the repo does not contain: `AGENTS.md:503,513,567` cite
  "All-Knowledge §…". Status: **docs fixed (Phase 1/5)**.

### S8 [Med] Polling renderers — CONFIRMED

- Orb polls on an interval (`src/orb/renderer/orb.ts:445` `setInterval`) and Chat
  every 2 s (`src/chat/renderer/chat.ts:900`), relying on key-stripping to avoid
  repaints. Fix: push coalesced deltas, keep one long safety poll. Status:
  **Phase 4**.

### S9 [Med] Main-thread DSP — CONFIRMED

- NLMS echo cancellation, noise reduction, DTW matching and VAD run in JS on the
  main process (`src/voice/echo-cancellation.ts`, `src/voice/session.ts:302`).
  Fix: move DSP into the Phase 2 sidecar / a worker. Status: **Phase 2/3**.

### S10 [Med] Capture details — CONFIRMED

- `src/voice/renderer/voice.ts:90` uses the deprecated `ScriptProcessorNode`
  (`createScriptProcessor`), not `AudioWorklet`. Constraints/resampler/frame
  counters need review. Status: **Phase 2/4**.

### S11 [Med] Dependency hygiene — CONFIRMED

- `package.json` devDependencies use carets (`electron: ^44.7.0`, etc.).
- `@voxrt/wake-word-browser` is a *runtime* dependency imported by main-process
  code (`src/voice/voxrt-detector.ts:26`) though it is a browser package and only
  opt-in. Fix: pin exact versions; remove or fully isolate VoxRT. Status:
  **Phase 1 (pin) / Phase 2 (isolate)**.

### S12 [Med] Platform matrix — CONFIRMED

- Only a `.deb` x64 target ships, while code/docs mention Windows acrylic and
  macOS vibrancy (`src/orb/backdrop.ts:24,30`). Fix: keep Linux x64 primary; make
  new components cross-platform-ready and document what is not shipped. Status:
  **documented (Phase 5)**.

### S13 [Low-Med] Wayland — CONFIRMED

- No Wayland/`XDG_SESSION_TYPE`/Ozone handling anywhere (`grep` returns nothing).
  Fix: detect session type, set the Ozone hint, use the XDG GlobalShortcuts
  portal where available, honest "shortcut unavailable on this session" state.
  Status: **Phase 3/4**.

### S14 [Low-Med] Backend URL safety — CONFIRMED

- `src/config.ts:51` `normalizeBaseUrl` accepts `http:` for any host, while a
  bearer token is sent from `ARIA_BACKEND_URL` overrides. Fix: require https
  except loopback, or an explicit insecure flag shown in Diagnostics. Status:
  **Phase 1**.

### S15 [Low] GPU policy — CONFIRMED

- `src/shell/gpu-policy.ts:36` probes only `/dev/dri/renderD128`/`card0`; misses
  valid NVIDIA/hybrid setups, no user control/visibility. Status: **Phase 3**.

### S16 [Low] Model display — CONFIRMED

- `ARIA_MODEL` is hardcoded (`src/config.ts:7`) and rendered read-only; if the
  backend changes models the UI can lie. `capabilities()` exists
  (`src/backend/aria-client.ts:163`) but the displayed model is not sourced from
  it. Fix: source the display from capabilities, label unknown when absent.
  Status: **Phase 4**.

### S17 [Low] Licensing/compliance — CONFIRMED

- No `LICENSE`, no `THIRD_PARTY_NOTICES` in the repo root. Fix: add a clearly
  marked license placeholder (not an invented license) and notices for fonts,
  the VoxRT model, and npm deps. Status: **Phase 1/5**.

### S18 [Low] Release hygiene — CONFIRMED

- Six 0.7.x releases in three days (`CHANGELOG.md:8,43,61,73,87,125,…`); no
  pre-release checklist script (`scripts/` has only build/security/smoke
  helpers); the release workflow does not run a voice smoke. Status: **Phase 5**.

## Additional findings (own)

### A1 [Med] Untracked wake model is not in `.gitignore`

- `wakewordmodel/voxrt_wake_word.vxrt` (100 KB) is untracked and un-ignored, so it
  can be committed accidentally; it is also a bundled-model licensing question
  (S17). Fix: add it to `.gitignore` and reference the model in
  `THIRD_PARTY_NOTICES`. Status: **Phase 1**.

### A2 [Low] `wakewordmodel/` is not referenced by any code path

- No source reads `wakewordmodel/`; the VoxRT detector expects the npm package
  model. Dead artifact. Fix: document or remove. Status: **Phase 1**.

### A3 [Low] `grantFileProtocolExtraPrivileges` has no security-gate coverage

- `scripts/security-check.mjs` checks the Electron floor, prod advisories and CSP
  but never the fuses, so S1 could regress silently. Fix: extend the gate (S1).
  Status: **Phase 1**.

### A4 [Med] `isAppUrl` trusts any `file://` prefix

- `src/shell/security.ts:71` treats every `file://` URL as trusted, including
  one outside the app bundle. With the `app://` move (S1) this narrows to the
  app origin. Status: **Phase 1**.

### A5 [Low] `README.md` configuration table omits several real env vars

- `ARIA_LOGIN_URL`, `ARIA_CONFIG_DIR`, `ARIA_FINGERPRINT_PATH`, `ARIA_ENABLE_GPU`/
  `ARIA_DISABLE_GPU`, `ARIA_WAKE_ENGINE` are read in code but missing from the
  README table. Status: **Phase 5**.

## Severity roll-up

- **P0/P1 (fix in Phase 1):** S1, S2 (docs), S4 (docs), S11 (pin), S14, A1, A3, A4.
- **P1 feature (Phase 2):** S3, S9, S10, S11 (isolate).
- **P2 (Phase 3/4):** S5, S6, S8, S12, S13, S15, S16.
- **P3 (Phase 5):** S7, S17, S18, A2, A5.

## Decisions recorded

- **Comment rule (R1) wins over the prompt's suggestion to write prose in code.**
  AGENTS.md forbids code comments except a one-line load-bearing invariant; the
  prompt's section 3 layout is satisfied with the directory/file structure and
  the external `docs/` prose, not inline narration. The earlier auth rewrite's
  multi-paragraph doc-comments are trimmed to the house rule in Phase 1.
- **Platform scope:** Linux x64 `.deb` remains the only shipped target.
- **License:** leave a marked placeholder; do not invent a license.
- **Backend is read-only:** `Beyonders-Backend` etc. are never modified (see
  AGENTS.md house rule). The live 503 (`CLI_AUTH_HMAC_SECRET` unset) is a
  deployment gap reported to the owner, not patched here.
