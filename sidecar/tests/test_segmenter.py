"""Utterance segmentation over a scripted VAD probability stream."""

from __future__ import annotations

import numpy as np

from aria_voice.segmenter import Segmenter, SegmenterSettings


def frames(n: int, value: int = 1000) -> list[np.ndarray]:
    return [np.full(320, value, dtype=np.int16) for _ in range(n)]


def test_min_speech_then_end_silence_emits_one_utterance() -> None:
    seg = Segmenter(SegmenterSettings(), frame_ms=20)
    speech = frames(30)
    silence = frames(50)
    events = []
    for f in speech:
        events.append(seg.push(f, 0.9))
    for f in silence:
        events.append(seg.push(f, 0.05))
    starts = [e for e in events if e.speech_start]
    utts = [e.utterance for e in events if e.utterance is not None]
    assert len(starts) == 1
    assert len(utts) == 1
    # speech (600 ms) plus pre-roll head, minus trailing silence padding.
    assert utts[0] is not None
    assert utts[0].size >= 320 * 25


def test_pre_roll_keeps_the_first_syllable() -> None:
    seg = Segmenter(SegmenterSettings(pre_roll_ms=300), frame_ms=20)
    lead = frames(10, value=7)
    for f in lead:
        seg.push(f, 0.0)
    events = []
    for f in frames(30):
        events.append(seg.push(f, 0.9))
    start = next(e for e in events if e.speech_start)
    assert start.speech_start
    # On finalize the pre-roll frames (value 7) must be present.
    for f in frames(50):
        events.append(seg.push(f, 0.0))
    utt = next(e.utterance for e in events if e.utterance is not None)
    assert utt is not None
    assert utt[0] == 7


def test_no_utterance_for_pure_silence() -> None:
    seg = Segmenter(SegmenterSettings(), frame_ms=20)
    events = [seg.push(f, 0.01) for f in frames(100)]
    assert not any(e.speech_start for e in events)
    assert not any(e.utterance is not None for e in events)


def test_max_utterance_forces_finalize() -> None:
    seg = Segmenter(SegmenterSettings(max_utterance_ms=200), frame_ms=20)
    events = [seg.push(f, 0.9) for f in frames(60)]
    assert any(e.utterance is not None for e in events)
