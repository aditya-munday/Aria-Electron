"""Model resolution and integrity.

Bundled openWakeWord models are resolved from the installed package; user models
live in a directory the app passes in. A user model is validated before it is
loaded: it must be a real file with an ``.onnx`` extension and, when a checksum
manifest is present, a matching SHA-256. A model that fails validation is
rejected with a reason rather than silently ignored.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass

MANIFEST_NAME = "models.json"


@dataclass
class ModelCheck:
    path: str
    ok: bool
    reason: str | None = None


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_manifest(model_dir: str | None) -> dict[str, str]:
    if not model_dir:
        return {}
    path = os.path.join(model_dir, MANIFEST_NAME)
    if not os.path.isfile(path):
        return {}
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError("model manifest must be an object of name -> sha256")
    return {str(k): str(v) for k, v in data.items()}


def validate_user_models(model_dir: str | None) -> list[ModelCheck]:
    """Validate every ``.onnx`` file in a user model directory."""
    if not model_dir or not os.path.isdir(model_dir):
        return []
    manifest = load_manifest(model_dir)
    checks: list[ModelCheck] = []
    for name in sorted(os.listdir(model_dir)):
        if not name.endswith(".onnx"):
            continue
        path = os.path.join(model_dir, name)
        expected = manifest.get(name)
        if expected is None:
            checks.append(ModelCheck(path=path, ok=False, reason="no checksum in manifest"))
            continue
        actual = sha256_file(path)
        if actual != expected:
            checks.append(ModelCheck(path=path, ok=False, reason="checksum mismatch"))
        else:
            checks.append(ModelCheck(path=path, ok=True))
    return checks
