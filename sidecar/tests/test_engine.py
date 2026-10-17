"""The engine pipeline, driven by deterministic capture/VAD/wake doubles."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import numpy as np

from aria_voice.engine import EngineDeps, VoiceEngine
from aria_voice.protocol import ConfigurePayload, FrameReader, FrameType
from aria_voice.wake import WakeEvent


class FakeCapture:
    def __init__(self, on_frame: Callable[[np.ndarray], None]) -> None:
        self.on_frame = on_frame
        self.started = False
        self.stopped = False
        self.xruns = 0

    def start(self, device_id: str | None = None) -> None:
        self.started = True

    def stop(self) -> None:
        self.stopped = True


class FakeVad:
    def __init__(self, probs: list[float]) -> None:
        self.providers = ["CPUExecutionProvider"]
        self._probs = iter(probs)

    def probability(self, window: np.ndarray) -> float:
        return next(self._probs, 0.0)

    def reset(self) -> None:
        pass


class FakeWake:
    def __init__(self, events: list[WakeEvent]) -> None:
        self._events = events
        self.threshold = 0.5

    def reset(self) -> None:
        pass

    def set_threshold(self, threshold: float) -> None:
        self.threshold = threshold

    def process(self, frame: np.ndarray) -> list[WakeEvent]:
        return list(self._events)


@dataclass
class Harness:
    engine: VoiceEngine
    frames: list[np.ndarray]
    events: list[dict[str, Any]]
    audio: list[np.ndarray]

    def event_kinds(self) -> list[str]:
        return [str(e.get("event")) for e in self.events]

    def of(self, kind: str) -> list[dict[str, Any]]:
        return [e for e in self.events if e.get("event") == kind]


def build(
    *,
    vad_probs: list[float] | None = None,
    wake_events: list[WakeEvent] | None = None,
) -> Harness:
    frames: list[np.ndarray] = []
    audio: list[np.ndarray] = []
    events: list[dict[str, Any]] = []
    reader = FrameReader()
    capture = FakeCapture(lambda f: frames.append(f))

    def emit(data: bytes) -> None:
        for ftype, payload in reader.feed(data):
            if ftype is FrameType.JSON:
                events.append(FrameReader.decode_json(payload))
            elif ftype is FrameType.AUDIO:
                audio.append(np.frombuffer(payload, dtype=np.int16))

    probs = vad_probs or [0.0] * 10000
    wakes = wake_events or []

    def vad_factory(providers: list[str]) -> FakeVad:
        return FakeVad(probs)

    def wake_factory(payload: ConfigurePayload, providers: list[str]) -> FakeWake:
        return FakeWake(wakes)

    engine = VoiceEngine(
        EngineDeps(
            emit=emit,
            capture_factory=lambda on_frame: capture,
            vad_factory=vad_factory,
            wake_factory=wake_factory,
            now=lambda: 0.0,
        )
    )
    return Harness(engine=engine, frames=frames, events=events, audio=audio)


def test_configure_emits_gpu_report() -> None:
    h = build()
    h.engine.configure(ConfigurePayload())
    reports = h.of("gpu_report")
    assert len(reports) == 1
    assert "CPUExecutionProvider" in reports[0]["chosen"]


def test_level_events_are_emitted_from_frames() -> None:
    h = build()
    h.engine.configure(ConfigurePayload(level_hz=20))
    h.engine.arm_listen()
    for _ in range(3):
        h.engine._on_frame(np.full(320, 1000, dtype=np.int16))
    assert len(h.of("level")) >= 1


def test_armed_listen_emits_a_wake() -> None:
    wake = WakeEvent(model="alexa_v0.1", score=0.8, ts=1.0)
    h = build(wake_events=[wake])
    h.engine.configure(ConfigurePayload())
    h.engine.arm_listen()
    h.engine._on_frame(np.zeros(1280, dtype=np.int16))
    wakes = h.of("wake")
    assert len(wakes) == 1
    assert wakes[0]["model"] == "alexa_v0.1"


def test_segmentation_emits_speech_bounds_and_audio() -> None:
    probs = [0.9] * 40 + [0.0] * 80
    h = build(vad_probs=probs)
    h.engine.configure(ConfigurePayload())
    h.engine.arm_listen()
    for _ in range(200):
        h.engine._on_frame(np.full(512, 2000, dtype=np.int16))
    assert len(h.of("speech_start")) == 1
    assert len(h.of("speech_end")) == 1
    assert len(h.audio) == 1
    assert h.audio[0].dtype == np.int16
    assert h.audio[0].size > 0


def test_calibration_emits_a_recommendation() -> None:
    h = build(vad_probs=[0.0] * 10000)
    h.engine.configure(ConfigurePayload())
    from aria_voice.protocol import CalibrateStartPayload

    h.engine.start_calibration(CalibrateStartPayload(phase="ambient", seconds=1.0))
    h.engine.stop_calibration()
    results = h.of("calibration_result")
    assert len(results) == 1
    assert 0.30 <= results[0]["threshold"] <= 0.90


def test_stop_calibration_without_start_is_an_error_event() -> None:
    h = build()
    h.engine.configure(ConfigurePayload())
    h.engine.stop_calibration()
    assert h.of("error")[0]["code"] == "no_calibration"
