"""The voice engine: command handling and the frame pipeline.

One capture stream feeds three consumers: a level meter, the Silero VAD, and —
when armed — the openWakeWord detector. A confirmed wake moves the engine into
listening, where the segmenter emits utterance bounds and audio. Everything the
engine does is observable through emitted events, so the Electron side never has
to guess whether the microphone is really streaming.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

import numpy as np

from . import gpu, resample
from .calibrate import recommend
from .diagnostics import info, warn
from .models import validate_user_models
from .protocol import (
    CalibrateStartPayload,
    ConfigurePayload,
    VadSettings,
    encode_audio,
    encode_json,
)
from .segmenter import Segmenter, SegmenterSettings
from .vad import WINDOW
from .wake import WakeEvent

Emit = Callable[[bytes], None]


class CaptureLike(Protocol):
    xruns: int

    def start(self, device_id: str | None = None) -> None: ...
    def stop(self) -> None: ...


class VadLike(Protocol):
    @property
    def providers(self) -> list[str]: ...
    def probability(self, frame: np.ndarray) -> float: ...
    def reset(self) -> None: ...


class WakeLike(Protocol):
    def process(self, frame: np.ndarray) -> list[WakeEvent]: ...
    def reset(self) -> None: ...
    def set_threshold(self, threshold: float) -> None: ...


@dataclass
class EngineDeps:
    emit: Emit
    capture_factory: Callable[[Callable[[np.ndarray], None]], CaptureLike]
    vad_factory: Callable[[list[str]], VadLike]
    wake_factory: Callable[[ConfigurePayload, list[str]], WakeLike]
    now: Callable[[], float] = time.monotonic


class VoiceEngine:
    def __init__(self, deps: EngineDeps) -> None:
        self._deps = deps
        self._config = ConfigurePayload()
        self._vad: VadLike | None = None
        self._wake: WakeLike | None = None
        self._segmenter: Segmenter | None = None
        self._capture: CaptureLike | None = None
        self._providers: list[str] = ["CPUExecutionProvider"]
        self._armed = False
        self._listening = False
        self._vad_pending = np.zeros(0, dtype=np.int16)
        self._last_level = float("-inf")
        self._level_period = 1.0 / max(1, self._config.level_hz)
        self._calibration: tuple[str, list[float]] | None = None
        self._metrics = {"frames": 0, "wakes": 0, "utterances": 0}

    def _emit_json(self, obj: dict[str, object]) -> None:
        self._deps.emit(encode_json(obj))

    def _emit_event(self, kind: str, **fields: object) -> None:
        self._emit_json({"event": kind, **fields})

    def configure(self, payload: ConfigurePayload) -> None:
        self._config = payload
        self._level_period = 1.0 / max(1, payload.level_hz)
        report = gpu.select_providers(payload.compute)
        self._providers = report.chosen
        self._vad = self._deps.vad_factory(self._providers)
        checks = validate_user_models(payload.wake_model_dir)
        for check in checks:
            if not check.ok:
                warn("wake model rejected", path=check.path, reason=check.reason)
        self._wake = self._deps.wake_factory(payload, self._providers)
        self._segmenter = Segmenter(
            settings=SegmenterSettings(
                threshold=payload.vad.threshold,
                hysteresis=payload.vad.hysteresis,
                min_speech_ms=payload.vad.min_speech_ms,
                end_silence_ms=payload.vad.end_silence_ms,
                speech_pad_ms=payload.vad.speech_pad_ms,
                pre_roll_ms=payload.vad.pre_roll_ms,
                max_utterance_ms=payload.vad.max_utterance_ms,
            ),
            frame_ms=payload.frame_ms,
        )
        self._emit_event(
            "gpu_report",
            available=report.available,
            chosen=report.chosen,
            reason=report.reason,
            vad_providers=self._vad.providers if self._vad else [],
        )

    def arm_listen(self) -> None:
        self._ensure_capture()
        self._armed = True
        self._listening = False
        self._vad_pending = np.zeros(0, dtype=np.int16)
        if self._wake is not None:
            self._wake.reset()
        self._emit_event("armed")

    def disarm(self) -> None:
        self._armed = False
        self._listening = False

    def _ensure_capture(self) -> None:
        if self._capture is not None:
            return
        self._capture = self._deps.capture_factory(self._on_frame)
        try:
            self._capture.start(None)
        except Exception as exc:
            warn("capture start failed", error=str(exc))
            self._capture = None
            self._emit_event("device_error", code="capture_failed", detail=str(exc))
            raise

    def stop_capture(self) -> None:
        if self._capture is not None:
            self._capture.stop()
            self._capture = None
        self._armed = False
        self._listening = False

    def set_threshold(self, threshold: float) -> None:
        if self._wake is not None:
            self._wake.set_threshold(threshold)
        self._config.threshold = threshold

    def set_vad(self, vad: VadSettings) -> None:
        self._config.vad = vad
        if self._segmenter is not None:
            self._segmenter.settings = SegmenterSettings(
                threshold=vad.threshold,
                hysteresis=vad.hysteresis,
                min_speech_ms=vad.min_speech_ms,
                end_silence_ms=vad.end_silence_ms,
                speech_pad_ms=vad.speech_pad_ms,
                pre_roll_ms=vad.pre_roll_ms,
                max_utterance_ms=vad.max_utterance_ms,
            )

    def start_calibration(self, payload: CalibrateStartPayload) -> None:
        self._calibration = (payload.phase, [])
        self._ensure_capture()
        self._emit_event("calibrating", phase=payload.phase, seconds=payload.seconds)

    def stop_calibration(self) -> None:
        if self._calibration is None:
            self._emit_event("error", code="no_calibration", detail="calibration was not running")
            return
        phase, scores = self._calibration
        self._calibration = None
        result = recommend(scores, []) if phase == "ambient" else recommend([], scores)
        self._emit_event(
            "calibration_result",
            phase=phase,
            threshold=result.threshold,
            noise_floor=result.noise_floor,
            weakest_positive=result.weakest_positive,
            positives=result.positives,
            confidence=result.confidence,
        )

    def metrics(self) -> None:
        self._emit_event("metrics", **self._metrics)

    def shutdown(self) -> None:
        self.stop_capture()

    def _on_frame(self, frame: np.ndarray) -> None:
        self._metrics["frames"] += 1
        now = self._deps.now()
        if now - self._last_level >= self._level_period:
            self._last_level = now
            self._emit_event("level", rms=resample.rms(frame), peak=resample.peak(frame))
        self._feed_vad(frame)
        if self._armed and self._wake is not None:
            self._feed_wake(frame)

    def _feed_vad(self, frame: np.ndarray) -> None:
        self._vad_pending = np.concatenate([self._vad_pending, frame])
        while len(self._vad_pending) >= WINDOW:
            window = self._vad_pending[:WINDOW]
            self._vad_pending = self._vad_pending[WINDOW:]
            prob = self._vad.probability(window) if self._vad else 0.0
            if self._calibration is not None:
                continue
            if self._listening or self._armed:
                self._segment(window, prob)

    def _segment(self, window: np.ndarray, prob: float) -> None:
        if self._segmenter is None:
            return
        events = self._segmenter.push(window, prob)
        if events.speech_start:
            self._listening = True
            self._emit_event("speech_start", vad_prob=prob)
        if events.utterance is not None:
            self._metrics["utterances"] += 1
            self._emit_event("speech_end", samples=int(events.utterance.size))
            self._deps.emit(encode_audio(events.utterance.astype(np.int16).tobytes()))
            self._listening = False

    def _feed_wake(self, frame: np.ndarray) -> None:
        if self._wake is None:
            return
        events = self._wake.process(frame)
        for event in events:
            self._metrics["wakes"] += 1
            info("wake", model=event.model, score=round(event.score, 3))
            self._emit_event("wake", model=event.model, score=event.score, ts=event.ts)
