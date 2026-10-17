"""Resampling, downmix and level maths."""

from __future__ import annotations

import numpy as np

from aria_voice import resample


def test_mono_passthrough() -> None:
    x = np.arange(10, dtype=np.int16)
    assert resample.to_mono(x) is x


def test_stereo_downmix_averages_channels() -> None:
    x = np.array([[100, 300], [200, 400]], dtype=np.int16)
    mono = resample.to_mono(x)
    assert list(mono) == [200, 300]


def test_same_rate_is_a_no_op() -> None:
    x = np.arange(100, dtype=np.int16)
    out = resample.resample_int16(x, 16000, 16000)
    assert out.dtype == np.int16
    assert np.array_equal(out, x)


def test_resample_changes_length_by_the_rate_ratio() -> None:
    x = (np.sin(np.linspace(0, 100, 48000)) * 10000).astype(np.int16)
    out = resample.resample_int16(x, 48000, 16000)
    assert out.dtype == np.int16
    assert abs(out.size - 16000) <= 2


def test_rms_and_peak() -> None:
    silence = np.zeros(100, dtype=np.int16)
    assert resample.rms(silence) == 0.0
    assert resample.peak(silence) == 0.0
    full = np.full(100, 32767, dtype=np.int16)
    assert resample.peak(full) > 0.99
    assert resample.rms(full) > 0.99
