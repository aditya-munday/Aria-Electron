"""Microphone capture via PortAudio (sounddevice).

Capture runs at the device's native rate and is resampled to 16 kHz mono int16
before it reaches the wake/VAD models. The PortAudio import is deferred to the
first use so the rest of the sidecar (and its tests) run on hosts without the
PortAudio shared library.

A callback-based input stream pushes blocks onto a bounded queue; a worker
drains it, resamples, and hands 16 kHz frames to the caller. A dropped block
(queue full) increments an xrun counter rather than blocking the audio thread,
which is the only safe behaviour in a real-time callback.
"""

from __future__ import annotations

import queue
import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import numpy as np

from . import resample

NATIVE_FALLBACK_RATE = 48000


@dataclass
class DeviceInfo:
    id: str
    label: str
    is_default: bool
    max_input_channels: int
    default_sample_rate: int


def list_input_devices() -> list[DeviceInfo]:
    sd = _sounddevice()
    devices: list[DeviceInfo] = []
    default_input = None
    try:
        default_input = sd.default.device[0]
    except Exception:
        default_input = None
    for index, raw in enumerate(sd.query_devices()):
        if raw.get("max_input_channels", 0) < 1:
            continue
        devices.append(
            DeviceInfo(
                id=str(index),
                label=str(raw.get("name", f"device {index}")),
                is_default=index == default_input,
                max_input_channels=int(raw.get("max_input_channels", 0)),
                default_sample_rate=int(raw.get("default_samplerate", NATIVE_FALLBACK_RATE)),
            )
        )
    return devices


def _sounddevice() -> Any:
    import sounddevice as sd

    return sd


class CaptureStream:
    """A resampling capture stream feeding 16 kHz mono int16 frames upward."""

    def __init__(
        self,
        *,
        on_frame: Callable[[np.ndarray], None],
        target_rate: int = resample.TARGET_RATE,
        blocksize: int = 1024,
        queue_max: int = 64,
        stream_factory: Callable[..., Any] | None = None,
    ) -> None:
        self._on_frame = on_frame
        self._target_rate = target_rate
        self._blocksize = blocksize
        self._queue: queue.Queue[np.ndarray] = queue.Queue(maxsize=queue_max)
        self._stream: Any = None
        self._worker: threading.Thread | None = None
        self._stop = threading.Event()
        self._source_rate = target_rate
        self.xruns = 0
        self._stream_factory = stream_factory

    @property
    def source_rate(self) -> int:
        return self._source_rate

    def _callback(self, indata: np.ndarray, frames: int, time_info: Any, status: Any) -> None:
        if status:
            self.xruns += 1
        try:
            self._queue.put_nowait(indata.copy())
        except queue.Full:
            self.xruns += 1

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                block = self._queue.get(timeout=0.1)
            except queue.Empty:
                continue
            mono = resample.to_mono(block)
            frame = resample.resample_int16(mono, self._source_rate, self._target_rate)
            if frame.size:
                self._on_frame(frame)

    def start(self, device_id: str | None = None) -> None:
        sd = _sounddevice()
        if device_id is not None and device_id != "":
            info = sd.query_devices(int(device_id))
        else:
            info = sd.query_devices(kind="input")
        self._source_rate = int(info.get("default_samplerate", NATIVE_FALLBACK_RATE))
        factory = self._stream_factory or sd.InputStream
        self._stream = factory(
            device=int(device_id) if device_id not in (None, "") else None,
            channels=1,
            samplerate=self._source_rate,
            blocksize=self._blocksize,
            dtype="int16",
            callback=self._callback,
        )
        self._stream.start()
        self._stop.clear()
        self._worker = threading.Thread(target=self._run, name="aria-capture", daemon=True)
        self._worker.start()

    def stop(self) -> None:
        self._stop.set()
        if self._stream is not None:
            try:
                self._stream.stop()
                self._stream.close()
            except Exception:
                pass
            self._stream = None
        if self._worker is not None:
            self._worker.join(timeout=1.0)
            self._worker = None
