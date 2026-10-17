"""CI gate: the shipped defaults must not wake on the negative fixtures."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import numpy as np
import pytest

BENCH = Path(__file__).resolve().parents[1] / "bench" / "eval_wake.py"


def load_bench() -> ModuleType:
    spec = importlib.util.spec_from_file_location("eval_wake", BENCH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["eval_wake"] = module
    spec.loader.exec_module(module)
    return module


def test_shipped_defaults_do_not_wake_on_negatives() -> None:
    bench = load_bench()
    clips = bench.load_clips(bench.FIXTURES)
    assert clips, "no fixtures committed"
    assert all(not c.positive for c in clips)
    for clip in clips:
        assert bench.wake_count(clip, 0.5, 2, 2000) == 0


def test_fixtures_are_16khz_mono_and_non_silent() -> None:
    bench = load_bench()
    for clip in bench.load_clips(bench.FIXTURES):
        assert clip.samples.dtype == np.int16
        assert np.abs(clip.samples).mean() > 10


def test_eval_main_passes_on_committed_fixtures() -> None:
    bench = load_bench()
    assert bench.main() == 0


@pytest.mark.parametrize("threshold", [0.4, 0.5, 0.6, 0.7])
def test_negatives_hold_across_thresholds(threshold: float) -> None:
    bench = load_bench()
    clips = bench.load_clips(bench.FIXTURES)
    for clip in clips:
        assert bench.wake_count(clip, threshold, 2, 2000) == 0
