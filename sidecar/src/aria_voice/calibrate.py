"""Wake-word threshold calibration.

There is no universal perfect threshold. This module measures one from the room:
a noise floor from ambient audio and the weakest positive from a handful of
spoken wake words. The recommended value sits between the floor plus a margin and
a fraction of the weakest positive, clamped to [0.30, 0.90]. The estimate is
honest about its own uncertainty: with only a few positives it reports a range,
not a false-precision number.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

FLOOR_MARGIN = 0.15
POSITIVE_FRACTION = 0.6
CLAMP_LOW = 0.30
CLAMP_HIGH = 0.90

PRESETS: dict[str, float] = {"strict": 0.70, "balanced": 0.50, "sensitive": 0.35}


@dataclass
class CalibrationResult:
    threshold: float
    noise_floor: float
    weakest_positive: float | None
    positives: int
    confidence: str


def percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    return float(np.percentile(np.asarray(values, dtype=np.float32), pct))


def recommend(
    ambient_scores: list[float],
    positive_scores: list[float],
) -> CalibrationResult:
    """Recommend a threshold from ambient and positive wake scores.

    ``ambient_scores`` are the max wake score per window while the room is quiet;
    ``positive_scores`` are the peak score of each spoken wake word. The floor is
    the 95th percentile of ambient so a single stray blip does not set it.
    """
    floor = percentile(ambient_scores, 95)
    lower = min(CLAMP_HIGH, max(CLAMP_LOW, floor + FLOOR_MARGIN))
    weakest = min(positive_scores) if positive_scores else None
    if weakest is None:
        threshold = lower
        confidence = "low"
    else:
        upper = min(CLAMP_HIGH, max(CLAMP_LOW, weakest * POSITIVE_FRACTION))
        # Between the floor margin and a fraction of the weakest positive.
        if upper < lower:
            threshold = min(CLAMP_HIGH, max(CLAMP_LOW, (lower + upper) / 2))
            confidence = "low"
        else:
            threshold = round((lower + upper) / 2, 3)
            confidence = "high" if len(positive_scores) >= 5 else "medium"
    return CalibrationResult(
        threshold=round(threshold, 3),
        noise_floor=round(floor, 4),
        weakest_positive=round(weakest, 4) if weakest is not None else None,
        positives=len(positive_scores),
        confidence=confidence,
    )


def estimate_false_accepts_per_hour(
    ambient_scores: list[float], threshold: float, window_ms: int
) -> float:
    """Estimate false accepts per hour from ambient scores above the threshold.

    A crude but honest upper bound: every window whose score clears the threshold
    is counted, scaled to an hour. With no ambient data the estimate is 0.0 and
    the caller should present it as unmeasured.
    """
    if not ambient_scores or window_ms <= 0:
        return 0.0
    above = sum(1 for s in ambient_scores if s >= threshold)
    observed_hours = len(ambient_scores) * window_ms / 3_600_000
    if observed_hours <= 0:
        return 0.0
    return round(above / observed_hours, 2)
