"""The real Silero VAD and openWakeWord models, loaded and scored.

These are integration tests: they load the bundled ONNX models (no download) and
assert the honest baseline — silence is not speech and is not a wake word.
"""

from __future__ import annotations

import numpy as np
import pytest

from aria_voice.vad import WINDOW, SileroVad
from aria_voice.wake import WakeDetector


def test_silero_vad_loads_and_scores_silence_low() -> None:
    vad = SileroVad()
    assert "CPUExecutionProvider" in vad.providers
    probs = [vad.probability(np.zeros(WINDOW, dtype=np.int16)) for _ in range(8)]
    assert max(probs) < 0.5


def test_silero_vad_rejects_a_wrong_frame_size() -> None:
    vad = SileroVad()
    with pytest.raises(ValueError):
        vad.probability(np.zeros(100, dtype=np.int16))


def test_alexa_model_loads_and_does_not_wake_on_noise() -> None:
    rng = np.random.default_rng(1234)
    detector = WakeDetector(models=["alexa_v0.1"], threshold=0.5, confirm_frames=2)
    assert detector.model_ids == ["alexa_v0.1"]
    noise = (rng.standard_normal(16000 * 3) * 50).astype(np.int16)
    events = []
    for i in range(0, len(noise) - 1280, 1280):
        events.extend(detector.process(noise[i : i + 1280]))
    assert events == []


def test_alexa_model_scores_silence_near_zero() -> None:
    detector = WakeDetector(models=["alexa_v0.1"], threshold=0.5, confirm_frames=2)
    scores = detector.score(np.zeros(1280 * 5, dtype=np.int16))
    assert scores
    assert max(scores.values()) < 0.1
