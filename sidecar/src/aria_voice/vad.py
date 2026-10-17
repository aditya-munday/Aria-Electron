"""Silero VAD (ONNX) streaming speech probability.

The bundled Silero model is the v5 variant: it takes a single float input window
plus a sample-rate tensor and a pair of recurrent state tensors (``h`` and
``c``), and returns the state for the next window. This wrapper owns that state
so callers push fixed-size int16 frames and read one probability.

The ONNX model ships inside openWakeWord's resources, so no download is needed
and no torch install is required.
"""

from __future__ import annotations

import os

import numpy as np

WINDOW = 512
STATE = 64
SAMPLE_RATE = 16000


def default_vad_path() -> str:
    import openwakeword

    return os.path.join(
        os.path.dirname(openwakeword.__file__), "resources", "models", "silero_vad.onnx"
    )


class SileroVad:
    def __init__(self, model_path: str | None = None, providers: list[str] | None = None) -> None:
        import onnxruntime as ort

        path = model_path or default_vad_path()
        options = ort.SessionOptions()
        options.inter_op_num_threads = 1
        options.intra_op_num_threads = 1
        available = ort.get_available_providers()
        chosen = [p for p in (providers or ["CPUExecutionProvider"]) if p in available]
        if not chosen:
            chosen = ["CPUExecutionProvider"]
        self._session = ort.InferenceSession(path, sess_options=options, providers=chosen)
        self._providers = chosen
        self._sr = np.array(SAMPLE_RATE, dtype=np.int64)
        self.reset()

    @property
    def providers(self) -> list[str]:
        return list(self._providers)

    def reset(self) -> None:
        self._h = np.zeros((2, 1, STATE), dtype=np.float32)
        self._c = np.zeros((2, 1, STATE), dtype=np.float32)

    def probability(self, frame: np.ndarray) -> float:
        """Return the speech probability for exactly one ``WINDOW``-sample int16 frame."""
        if frame.shape[0] != WINDOW:
            raise ValueError(f"Silero VAD needs {WINDOW}-sample frames, got {frame.shape[0]}")
        as_float = (frame.astype(np.float32) / 32768.0)[None, :]
        out, self._h, self._c = self._session.run(
            None, {"input": as_float, "sr": self._sr, "h": self._h, "c": self._c}
        )
        return float(np.asarray(out).reshape(-1)[0])
