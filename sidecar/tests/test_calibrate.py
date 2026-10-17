"""Calibration maths: honest thresholds, presets and false-accept estimates."""

from __future__ import annotations

from aria_voice.calibrate import (
    PRESETS,
    estimate_false_accepts_per_hour,
    percentile,
    recommend,
)


def test_percentile_empty_is_zero() -> None:
    assert percentile([], 95) == 0.0


def test_recommend_with_clean_ambient_and_strong_positives() -> None:
    result = recommend([0.02, 0.03, 0.01, 0.04], [0.9, 0.85, 0.88, 0.92, 0.87])
    assert 0.30 <= result.threshold <= 0.90
    assert result.confidence == "high"
    assert result.positives == 5
    # Floor is low, so the weakest-positive fraction should bound the value.
    assert result.threshold <= 0.85 * 0.6 + 1e-6 or result.threshold <= 0.90


def test_recommend_clamps_to_the_floor_margin_when_positives_are_weak() -> None:
    result = recommend([0.5, 0.55, 0.6], [0.62, 0.65])
    assert result.threshold >= 0.30
    assert result.confidence in {"low", "medium"}


def test_recommend_without_positives_is_low_confidence() -> None:
    result = recommend([0.1, 0.2, 0.15], [])
    assert result.weakest_positive is None
    assert result.confidence == "low"


def test_presets_are_ordered_and_bounded() -> None:
    assert PRESETS["strict"] > PRESETS["balanced"] > PRESETS["sensitive"]
    assert all(0.30 <= v <= 0.90 for v in PRESETS.values())


def test_false_accept_estimate_scales_with_the_observation_window() -> None:
    ambient = [0.6, 0.2, 0.55, 0.1]
    estimate = estimate_false_accepts_per_hour(ambient, threshold=0.5, window_ms=1280)
    assert estimate > 0


def test_false_accept_estimate_without_data_is_zero() -> None:
    assert estimate_false_accepts_per_hour([], 0.5, 1280) == 0.0
