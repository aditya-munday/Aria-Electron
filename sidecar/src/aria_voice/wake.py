"""Wake-word detection: openWakeWord ONNX models behind a small state machine.

The state machine is deliberately conservative. A single high score is not a
wake: the score must stay at or above the threshold for ``confirm_frames``
consecutive frames, and a second wake is suppressed for ``cooldown_ms``. On a
confirmed wake the model buffers are reset so the trailing audio that produced
the score cannot immediately re-trigger, and the caller moves to listening.

openWakeWord expects 16 kHz mono int16 in 80 ms (1280-sample) steps. Incoming
frames are accumulated to that size here so callers may use any frame length.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

import numpy as np

MODEL_STEP = 1280
DEFAULT_MODEL = "alexa_v0.1"


@dataclass
class WakeEvent:
    model: str
    score: float
    ts: float


def default_model_path(model: str) -> str:
    """Resolve a bundled openWakeWord model name to its ONNX path."""
    import openwakeword

    resources = os.path.join(os.path.dirname(openwakeword.__file__), "resources", "models")
    name = model if model.endswith(".onnx") else f"{model}.onnx"
    return os.path.join(resources, name)


def resolve_models(names: list[str], model_dir: str | None) -> list[str]:
    """Resolve model names to paths, preferring ``model_dir`` when given.

    A user model directory (``ARIA_WAKE_MODEL_DIR`` / ``userData/wake-models``)
    is searched first so a custom model can override a bundled one by name.
    """
    paths: list[str] = []
    for name in names:
        filename = name if name.endswith(".onnx") else f"{name}.onnx"
        if model_dir is not None:
            candidate = os.path.join(model_dir, filename)
            if os.path.isfile(candidate):
                paths.append(candidate)
                continue
        paths.append(default_model_path(name))
    return paths


class WakeDetector:
    def __init__(
        self,
        *,
        models: list[str],
        model_dir: str | None = None,
        threshold: float = 0.5,
        confirm_frames: int = 2,
        cooldown_ms: int = 2000,
        sample_rate: int = 16000,
        now: Any = None,
        model: Any = None,
    ) -> None:
        from openwakeword.model import Model

        self._paths = resolve_models(models, model_dir)
        self._model = model if model is not None else Model(wakeword_model_paths=self._paths)
        self._labels = list(self._model.models.keys())
        self._threshold = threshold
        self._confirm_frames = confirm_frames
        self._cooldown_s = cooldown_ms / 1000.0
        self._sample_rate = sample_rate
        self._now = now or (lambda: __import__("time").monotonic())
        self._pending = np.zeros(0, dtype=np.int16)
        self._streak = 0
        self._last_wake = float("-inf")

    @property
    def model_ids(self) -> list[str]:
        return list(self._labels)

    def set_threshold(self, threshold: float) -> None:
        self._threshold = threshold

    def reset(self) -> None:
        self._pending = np.zeros(0, dtype=np.int16)
        self._streak = 0
        self._model.reset()

    def score(self, frame: np.ndarray) -> dict[str, float]:
        """Return the raw per-model score for a frame, without the state machine."""
        self._pending = np.concatenate([self._pending, frame.astype(np.int16, copy=False)])
        last: dict[str, float] = {}
        while len(self._pending) >= MODEL_STEP:
            chunk = self._pending[:MODEL_STEP]
            self._pending = self._pending[MODEL_STEP:]
            scores = self._model.predict(chunk)
            last = {str(k): float(v) for k, v in scores.items()}
        return last

    def process(self, frame: np.ndarray) -> list[WakeEvent]:
        """Feed one frame; return a wake event when the phrase is confirmed."""
        scores = self.score(frame)
        if not scores:
            return []
        best_label = max(scores, key=lambda k: scores[k])
        best = scores[best_label]
        if best < self._threshold:
            self._streak = 0
            return []
        self._streak += 1
        now = float(self._now())
        if self._streak < self._confirm_frames:
            return []
        if now - self._last_wake < self._cooldown_s:
            return []
        self._last_wake = now
        self._streak = 0
        self.reset()
        return [WakeEvent(model=best_label, score=best, ts=now)]
