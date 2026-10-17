"""Resampling to the 16 kHz mono int16 the wake/VAD models expect.

Capture runs at the device's native rate; the models do not. ``soxr`` does the
band-limited resample in one call, which is both faster and higher quality than a
naive linear interpolation for the 44.1/48 kHz sources we see in practice.
"""

from __future__ import annotations

import numpy as np
import soxr

TARGET_RATE = 16000


def to_mono(samples: np.ndarray) -> np.ndarray:
    """Downmix interleaved or multi-channel int16/float input to one channel."""
    if samples.ndim == 1:
        return samples
    if samples.ndim != 2:
        raise ValueError(f"expected 1-D or 2-D audio, got {samples.ndim}-D")
    channels = samples.shape[1] if samples.shape[0] < samples.shape[1] else samples.shape[0]
    if samples.shape[1] == channels and samples.shape[1] > 1:
        return samples.mean(axis=1)
    return samples


def resample_int16(
    samples: np.ndarray, source_rate: int, target_rate: int = TARGET_RATE
) -> np.ndarray:
    """Resample mono int16 audio, returning mono int16 at ``target_rate``.

    A no-op when the rates already match, so the common 16 kHz device path adds
    no work and no rounding noise.
    """
    mono = to_mono(np.asarray(samples))
    if source_rate == target_rate:
        return mono.astype(np.int16, copy=False)
    if source_rate <= 0 or target_rate <= 0:
        raise ValueError("sample rates must be positive")
    as_float = mono.astype(np.float32)
    resampled = np.asarray(soxr.resample(as_float, source_rate, target_rate))
    clipped = np.clip(np.round(resampled), -32768, 32767)
    return clipped.astype(np.int16)


def rms(samples: np.ndarray) -> float:
    """Root-mean-square level in [0, 1] for an int16 frame."""
    if samples.size == 0:
        return 0.0
    as_float = samples.astype(np.float32) / 32768.0
    return float(np.sqrt(np.mean(np.square(as_float))))


def peak(samples: np.ndarray) -> float:
    """Peak absolute level in [0, 1] for an int16 frame."""
    if samples.size == 0:
        return 0.0
    return float(np.max(np.abs(samples.astype(np.float32))) / 32768.0)
