"""Regenerate the committed negative WAV fixtures.

Deterministic (fixed seed) so the fixtures and the CI gate are reproducible.
These are negatives only; real wake-word positives cannot be shipped.
"""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np

OUT = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "wake"
RATE = 16000
SECONDS = 3


def write(name: str, samples: np.ndarray) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    clipped = np.clip(samples, -32768, 32767).astype(np.int16)
    with wave.open(str(OUT / name), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes(clipped.tobytes())


def lowpass(x: np.ndarray, alpha: float) -> np.ndarray:
    out = np.empty_like(x)
    acc = 0.0
    for i, value in enumerate(x):
        acc += alpha * (value - acc)
        out[i] = acc
    return out


def main() -> None:
    rng = np.random.default_rng(2024)
    n = RATE * SECONDS
    write("neg_noise.wav", rng.standard_normal(n) * 3000)
    t = np.arange(n) / RATE
    write("neg_tone.wav", np.sin(2 * np.pi * 440 * t) * 8000)
    write("neg_fan.wav", lowpass(rng.standard_normal(n), 0.02) * 6000)
    music = (
        np.sin(2 * np.pi * 220 * t)
        + 0.5 * np.sin(2 * np.pi * 330 * t)
        + 0.3 * np.sin(2 * np.pi * 660 * t)
    )
    envelope = 0.5 + 0.5 * np.sin(2 * np.pi * 2 * t)
    write("neg_music.wav", music * envelope * 4000)
    print(f"wrote 4 fixtures to {OUT}")


if __name__ == "__main__":
    main()
