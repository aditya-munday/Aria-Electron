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

## Fonts

| Component | Location | License |
| --- | --- | --- |
| Inter | `src/renderer/fonts/Inter-*.woff2` | SIL Open Font License 1.1 |

Inter is self-hosted; no font is fetched at runtime.

## Toolchain (not shipped)

`electron`, `electron-builder`, `esbuild`, `typescript`, `vitest`, `jsdom` and
`@types/node` are devDependencies. Electron's runtime is packaged inside the
`.deb`; see its own notices for the bundled Chromium and Node licenses.
