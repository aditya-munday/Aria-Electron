# Third-party notices

Aria-Electron bundles or depends on the components below. Each is the property
of its authors and is used under its own license. This file records what ships
so a redistribution can carry the required notices.

## Runtime dependencies

| Component | Version | License |
| --- | --- | --- |
| `zod` | 3.25.76 | MIT |
| `@voxrt/wake-word-browser` | 0.1.1 | Apache-2.0 |

`@voxrt/wake-word-browser` is an **optional** wake-word engine: it is loaded
only when `ARIA_WAKE_ENGINE=voxrt` selects it, and the default build uses the
in-process detector. Its code is not invoked on the default path.

## Bundled model artifact

| Component | Location | License |
| --- | --- | --- |
| VoxRT wake-word model (`voxrt_wake_word.vxrt`) | `wakewordmodel/` (untracked; `.gitignore`) | Apache-2.0 (per the `@voxrt` package) |

The model is a data artifact consumed by the VoxRT engine. It is not part of the
default build and is not committed to this repository.

## Voice sidecar (bundled executable)

The packaged `.deb` ships the Python voice sidecar as a self-contained
executable under `resources/sidecar/aria-voice/` (see `docs/VOICE_SIDECAR.md`).
Its runtime dependencies are:

| Component | Version | License |
| --- | --- | --- |
| openWakeWord | 0.4.0 | Apache-2.0 |
| onnxruntime | 1.31.0 | MIT |
| numpy | 2.5.4 | BSD-3-Clause |
| scipy | 1.18.1 | BSD-3-Clause |
| sounddevice | 0.5.6 | MIT |
| soxr | 1.1.0 | LGPL-2.1-or-later |
| pydantic | 2.14.1 | MIT |

`soxr` is LGPL-2.1-or-later; it is bundled as a dynamically loaded extension
module, which keeps it separately replaceable as the LGPL requires.

### Bundled wake models

The sidecar bundles openWakeWord's pre-trained models (the melspectrogram and
embedding backbones plus the selectable wake models). openWakeWord's *code* is
Apache-2.0, but its pre-trained *models* are licensed
[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) because of
restrictive training data, i.e. **non-commercial**. This restricts commercial
redistribution of the shipped wake models.

| Artifact | Location | License |
| --- | --- | --- |
| `melspectrogram.onnx`, `embedding_model.onnx` | bundled in the sidecar | CC BY-NC-SA 4.0 |
| `alexa_v0.1.onnx`, `hey_jarvis_v0.1.onnx`, `timer_v0.1.onnx`, … | bundled in the sidecar | CC BY-NC-SA 4.0 |
| `silero_vad.onnx` (Silero VAD) | bundled in the sidecar | MIT |

"Alexa" is a third-party trademark; it is presented as a selectable model name
only. The intended product wake word is a custom-trained "Hey Aria" model
(`docs/WAKE_WORD.md`). For commercial use, train or import a model under a
permissive license via openWakeWord's training pipeline; the registry accepts a
custom `.onnx` with no code change.

## Fonts

| Component | Location | License |
| --- | --- | --- |
| Inter | `src/renderer/fonts/Inter-*.woff2` | SIL Open Font License 1.1 |

Inter is self-hosted; no font is fetched at runtime.

## Toolchain (not shipped)

`electron`, `electron-builder`, `esbuild`, `typescript`, `vitest`, `jsdom` and
`@types/node` are devDependencies. Electron's runtime is packaged inside the
`.deb`; see its own notices for the bundled Chromium and Node licenses.
