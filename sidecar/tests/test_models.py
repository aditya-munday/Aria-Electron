"""User-model validation against a checksum manifest."""

from __future__ import annotations

import json
from pathlib import Path

from aria_voice.models import load_manifest, sha256_file, validate_user_models


def test_validate_accepts_a_matching_checksum(tmp_path: Path) -> None:
    model = tmp_path / "custom.onnx"
    model.write_bytes(b"model-bytes")
    (tmp_path / "models.json").write_text(
        json.dumps({"custom.onnx": sha256_file(str(model))}), encoding="utf-8"
    )
    checks = validate_user_models(str(tmp_path))
    assert len(checks) == 1
    assert checks[0].ok


def test_validate_rejects_a_missing_checksum(tmp_path: Path) -> None:
    (tmp_path / "custom.onnx").write_bytes(b"x")
    checks = validate_user_models(str(tmp_path))
    assert checks[0].ok is False
    assert checks[0].reason == "no checksum in manifest"


def test_validate_rejects_a_mismatched_checksum(tmp_path: Path) -> None:
    (tmp_path / "custom.onnx").write_bytes(b"x")
    (tmp_path / "models.json").write_text(json.dumps({"custom.onnx": "deadbeef"}), encoding="utf-8")
    checks = validate_user_models(str(tmp_path))
    assert checks[0].ok is False
    assert checks[0].reason == "checksum mismatch"


def test_validate_of_a_missing_dir_is_empty() -> None:
    assert validate_user_models(None) == []
    assert validate_user_models("/nope") == []


def test_load_manifest_rejects_a_non_object(tmp_path: Path) -> None:
    (tmp_path / "models.json").write_text("[1,2]", encoding="utf-8")
    try:
        load_manifest(str(tmp_path))
    except ValueError:
        return
    raise AssertionError("expected ValueError")
