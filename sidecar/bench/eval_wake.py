"""Wake-word evaluation harness.

Sweeps threshold x confirm-frames x cooldown over labelled WAV fixtures and
reports, for each combination, the false-rejection rate (positives missed) and
the false-accepts per hour (negatives that woke).

Fixtures are read from ``tests/fixtures/wake``. A file whose name starts with
``pos_`` is a wake-word recording; ``neg_`` is anything that must not wake. The
committed fixtures are negatives only — real "Alexa" recordings cannot be
shipped, and TTS-generated positives must never be used to claim real-world
accuracy, so FRR is reported as unmeasured unless real positives are supplied.

Run: ``uv run python bench/eval_wake.py``
"""

from __future__ import annotations

import itertools
import sys
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from aria_voice.wake import WakeDetector  # noqa: E402

FIXTURES = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "wake"
MODEL = "alexa_v0.1"


@dataclass
class Clip:
    name: str
    positive: bool
    samples: np.ndarray

    @property
    def seconds(self) -> float:
        return self.samples.size / 16000


def load_clips(directory: Path) -> list[Clip]:
    clips: list[Clip] = []
    for path in sorted(directory.glob("*.wav")):
        with wave.open(str(path), "rb") as handle:
            if handle.getframerate() != 16000 or handle.getnchannels() != 1:
                raise ValueError(f"{path.name} must be 16 kHz mono")
            raw = handle.readframes(handle.getnframes())
        samples = np.frombuffer(raw, dtype=np.int16)
        clips.append(Clip(name=path.name, positive=path.name.startswith("pos_"), samples=samples))
    return clips


def wake_count(clip: Clip, threshold: float, confirm: int, cooldown_ms: int) -> int:
    detector = WakeDetector(
        models=[MODEL], threshold=threshold, confirm_frames=confirm, cooldown_ms=cooldown_ms
    )
    count = 0
    for i in range(0, clip.samples.size - 1280 + 1, 1280):
        count += len(detector.process(clip.samples[i : i + 1280]))
    return count


def evaluate(clips: list[Clip], threshold: float, confirm: int, cooldown_ms: int) -> dict[str, Any]:
    positives = [c for c in clips if c.positive]
    negatives = [c for c in clips if not c.positive]
    missed = sum(1 for c in positives if wake_count(c, threshold, confirm, cooldown_ms) == 0)
    false_wakes = sum(wake_count(c, threshold, confirm, cooldown_ms) for c in negatives)
    negative_hours = sum(c.seconds for c in negatives) / 3600
    frr = (missed / len(positives)) if positives else None
    fa_per_hour = (false_wakes / negative_hours) if negative_hours > 0 else 0.0
    return {
        "threshold": threshold,
        "confirm": confirm,
        "cooldown_ms": cooldown_ms,
        "frr": frr,
        "false_accepts_per_hour": fa_per_hour,
    }


def main() -> int:
    if not FIXTURES.is_dir():
        print(f"no fixtures at {FIXTURES}")
        return 1
    clips = load_clips(FIXTURES)
    if not clips:
        print(f"no WAV fixtures in {FIXTURES}")
        return 1
    positives = sum(1 for c in clips if c.positive)
    print(f"{len(clips)} clips ({positives} positive, {len(clips) - positives} negative)")
    if positives == 0:
        print("no real positives committed: FRR is unmeasured (see module docstring)")
    print(f"{'thresh':>7} {'confirm':>7} {'cool_ms':>8} {'FRR':>8} {'FA/hr':>8}")
    grid = itertools.product([0.4, 0.5, 0.6, 0.7], [1, 2, 3], [1500, 2000])
    for threshold, confirm, cooldown in grid:
        result = evaluate(clips, threshold, confirm, cooldown)
        frr = "n/a" if result["frr"] is None else f"{result['frr']:.3f}"
        print(
            f"{threshold:>7.2f} {confirm:>7d} {cooldown:>8d} "
            f"{frr:>8} {result['false_accepts_per_hour']:>8.2f}"
        )
    baseline = evaluate(clips, 0.5, 2, 2000)
    if baseline["false_accepts_per_hour"] > 0:
        print("FAIL: shipped defaults produced a false accept on the negative fixtures")
        return 1
    print("ok: shipped defaults produced zero false accepts on the negative fixtures")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
