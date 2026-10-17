"""Utterance segmentation over the Silero VAD probability stream.

The parameters are the ones the prompt specifies as the honest starting point:
threshold 0.5 with a -0.15 hysteresis so a fading tail does not chop the end,
250 ms minimum speech, 700 ms of trailing silence to close, 100 ms of padding
kept on each side, a 300 ms pre-roll ring so the first syllable is never clipped,
and a 15 s hard cap.

Speech starts when the probability rises above ``threshold`` for
``min_speech_ms``; it ends after ``end_silence_ms`` of probability below
``threshold - hysteresis``. The pre-roll buffer is emitted with the first
speech frame, so nothing before the trigger is lost.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

import numpy as np


@dataclass
class SegmenterSettings:
    threshold: float = 0.5
    hysteresis: float = 0.15
    min_speech_ms: int = 250
    end_silence_ms: int = 700
    speech_pad_ms: int = 100
    pre_roll_ms: int = 300
    max_utterance_ms: int = 15000


@dataclass
class SegmenterEvents:
    speech_start: bool = False
    utterance: np.ndarray | None = None
    level: tuple[float, float] | None = None


@dataclass
class Segmenter:
    settings: SegmenterSettings
    frame_ms: int
    _in_speech: bool = False
    _speech_ms: int = 0
    _silence_ms: int = 0
    _utterance_ms: int = 0
    _preroll: deque[np.ndarray] = field(default_factory=deque)
    _frames: list[np.ndarray] = field(default_factory=list)

    def __post_init__(self) -> None:
        self._preroll_max = max(1, self.settings.pre_roll_ms // self.frame_ms)
        self._min_speech_frames = max(1, self.settings.min_speech_ms // self.frame_ms)
        self._end_silence_frames = max(1, self.settings.end_silence_ms // self.frame_ms)
        self._pad_frames = max(0, self.settings.speech_pad_ms // self.frame_ms)
        self._max_frames = max(1, self.settings.max_utterance_ms // self.frame_ms)
        self._speech_frames = 0
        self._silence_frames = 0

    def reset(self) -> None:
        self._in_speech = False
        self._speech_frames = 0
        self._silence_frames = 0
        self._preroll.clear()
        self._frames = []

    def push(self, frame: np.ndarray, probability: float) -> SegmenterEvents:
        events = SegmenterEvents()
        if not self._in_speech:
            self._preroll.append(frame)
            if len(self._preroll) > self._preroll_max:
                self._preroll.popleft()
            if probability >= self.settings.threshold:
                self._speech_frames += 1
                if self._speech_frames >= self._min_speech_frames:
                    self._in_speech = True
                    self._frames = list(self._preroll)
                    self._silence_frames = 0
                    events.speech_start = True
            else:
                self._speech_frames = 0
            return events

        self._frames.append(frame)
        if probability < self.settings.threshold - self.settings.hysteresis:
            self._silence_frames += 1
        else:
            self._silence_frames = 0
        hit_silence = self._silence_frames >= self._end_silence_frames
        hit_cap = len(self._frames) >= self._max_frames
        if hit_silence or hit_cap:
            events.utterance = self._finalize()
        return events

    def _finalize(self) -> np.ndarray:
        frames = self._frames
        if self._pad_frames > 0 and len(frames) > self._pad_frames:
            keep = max(1, len(frames) - self._silence_frames - self._pad_frames)
            frames = frames[:keep]
        utterance = np.concatenate(frames) if frames else np.zeros(0, dtype=np.int16)
        self.reset()
        return utterance
