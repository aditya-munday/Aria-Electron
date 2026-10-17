# PyInstaller spec for the aria-voice sidecar.
#
# The sidecar must ship as a self-contained executable so a stock Linux install
# needs no Python and no `uv`. The openWakeWord and Silero ONNX models are
# bundled as data (they are loaded from the package's `resources/models`
# directory at runtime, so that path must survive into the frozen bundle).
#
# Build: `uv run --group build pyinstaller --clean --noconfirm aria-voice.spec`
# Output: `dist/aria-voice` (one-dir; a one-file build re-extracts on every
# launch, which is the wrong trade for a process that starts with the app).

import os

import openwakeword
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

# The bundled ONNX models (alexa_v0.1, silero_vad, the mel/embedding framework
# models) live under the package's resources directory.
openwakeword_dir = os.path.dirname(openwakeword.__file__)
models_dir = os.path.join(openwakeword_dir, "resources", "models")

datas = [
    (models_dir, os.path.join("openwakeword", "resources", "models")),
]
# openWakeWord discovers its framework models by directory listing; keep the
# package's data files too.
datas += collect_data_files("openwakeword")

hiddenimports = collect_submodules("openwakeword")
hiddenimports += ["onnxruntime", "soxr", "sounddevice", "numpy", "pydantic"]
# scipy lazy-loads submodules through a namespace that PyInstaller's static
# analysis misses (`scipy._external.array_api_compat.*`), so collect them
# explicitly: collect_submodules('scipy') does not descend into the `_external`
# namespace package.
hiddenimports += collect_submodules("scipy._external")

a = Analysis(
    ["entrypoint.py"],
    pathex=["src"],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # openWakeWord's preprocessing needs scipy, so it must not be excluded.
    excludes=["torch", "tensorflow", "matplotlib", "tkinter"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="aria-voice",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="aria-voice",
)
