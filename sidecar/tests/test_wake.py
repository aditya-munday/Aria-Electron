"""Wake state machine: confirmation, cooldown, reset, model resolution."""

from __future__ import annotations

import os
from collections.abc import Callable
from pathlib import Path

import numpy as np

from aria_voice.wake import WakeDetector, WakeEvent, resolve_models


class FakeModel:
    def __init__(self, score: float) -> None:
        self.models = {"alexa_v0.1": object()}
        self._score = score
        self.resets = 0

    def predict(self, chunk: np.ndarray) -> dict[str, float]:
        return {"alexa_v0.1": self._score}

    def reset(self) -> None:
        self.resets += 1


def make(
    score: float,
    *,
    confirm: int = 2,
    cooldown_ms: int = 2000,
    clock: Callable[[], float] | None = None,
) -> tuple[WakeDetector, FakeModel]:
    model = FakeModel(score)
    detector = WakeDetector(
        models=["alexa_v0.1"],
        threshold=0.5,
        confirm_frames=confirm,
        cooldown_ms=cooldown_ms,
        now=clock or (lambda: 0.0),
        model=model,
    )
    return detector, model


def step(detector: WakeDetector) -> list[WakeEvent]:
    # 1280 samples = exactly one openWakeWord step.
    return detector.process(np.zeros(1280, dtype=np.int16))


def test_requires_consecutive_frames_to_confirm() -> None:
    detector, _ = make(0.9, confirm=2)
    assert step(detector) == []
    events = step(detector)
    assert len(events) == 1
    assert events[0].model == "alexa_v0.1"


def test_below_threshold_never_wakes() -> None:
    detector, _ = make(0.2, confirm=1)
    assert all(step(detector) == [] for _ in range(10))


def test_streak_resets_on_a_low_frame() -> None:
    model = FakeModel(0.9)
    scores = iter([0.9, 0.1, 0.9, 0.9])
    detector = WakeDetector(
        models=["alexa_v0.1"],
        threshold=0.5,
        confirm_frames=2,
        now=lambda: 0.0,
        model=model,
    )
    model.predict = lambda chunk: {"alexa_v0.1": next(scores)}  # type: ignore[method-assign]
    assert detector.process(np.zeros(1280, dtype=np.int16)) == []
    assert detector.process(np.zeros(1280, dtype=np.int16)) == []
    assert detector.process(np.zeros(1280, dtype=np.int16)) == []
    events = detector.process(np.zeros(1280, dtype=np.int16))
    assert len(events) == 1


def test_cooldown_suppresses_a_second_wake() -> None:
    clock = {"t": 0.0}
    detector, _ = make(0.9, confirm=1, cooldown_ms=2000, clock=lambda: clock["t"])
    assert len(step(detector)) == 1
    assert step(detector) == []
    clock["t"] = 2.5
    assert len(step(detector)) == 1


def test_wake_resets_the_model_buffers() -> None:
    detector, model = make(0.9, confirm=1)
    step(detector)
    assert model.resets >= 1


def test_resolve_models_prefers_user_dir(tmp_path: Path) -> None:
    custom = tmp_path / "alexa_v0.1.onnx"
    custom.write_bytes(b"not-a-real-model")
    paths = resolve_models(["alexa_v0.1"], str(tmp_path))
    assert paths == [str(custom)]


def test_resolve_models_falls_back_to_bundled() -> None:
    paths = resolve_models(["alexa_v0.1"], None)
    assert paths[0].endswith("alexa_v0.1.onnx")
    assert os.path.isfile(paths[0])
