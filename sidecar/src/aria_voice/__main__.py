"""Sidecar entrypoint: read framed commands on stdin, write framed events on stdout.

The process is the isolation boundary the Electron main process relies on: a
native or model fault here can crash this process but never the app. It reads
only stdin, writes only stdout/stderr, opens no sockets, and exits when stdin
closes (its parent is gone) or on an explicit shutdown.
"""

from __future__ import annotations

import ctypes
import os
import sys
import threading
from typing import Any

from pydantic import ValidationError

from . import diagnostics as diag
from .capture import CaptureStream, list_input_devices
from .engine import EngineDeps, VoiceEngine
from .protocol import (
    PROTOCOL_VERSION,
    CalibrateStartPayload,
    Command,
    ConfigurePayload,
    FrameReader,
    FrameType,
    SetThresholdPayload,
    SetVadPayload,
    encode_json,
)
from .vad import SileroVad
from .wake import WakeDetector

_write_lock = threading.Lock()


def _emit(data: bytes) -> None:
    with _write_lock:
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()


def _pdeathsig() -> None:
    """On Linux, ask the kernel to signal us when the parent dies."""
    try:
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        libc.prctl(1, 15, 0, 0, 0)  # PR_SET_PDEATHSIG, SIGTERM
    except Exception:
        pass


def _vad_factory(providers: list[str]) -> SileroVad:
    return SileroVad(providers=providers)


def _wake_factory(payload: ConfigurePayload, providers: list[str]) -> WakeDetector:
    return WakeDetector(
        models=payload.wake_models,
        model_dir=payload.wake_model_dir,
        threshold=payload.threshold,
        confirm_frames=payload.confirm_frames,
        cooldown_ms=payload.cooldown_ms,
        sample_rate=payload.sample_rate,
    )


def _capture_factory(on_frame: Any) -> CaptureStream:
    return CaptureStream(on_frame=on_frame)


def build_engine() -> VoiceEngine:
    return VoiceEngine(
        EngineDeps(
            emit=_emit,
            capture_factory=_capture_factory,
            vad_factory=_vad_factory,
            wake_factory=_wake_factory,
        )
    )


def _dispatch(engine: VoiceEngine, command: Command) -> bool:
    """Handle one command. Returns False to stop the loop."""
    try:
        if command.type == "configure":
            engine.configure(ConfigurePayload(**command.payload))
        elif command.type == "start_capture":
            engine.arm_listen()
        elif command.type == "stop_capture":
            engine.stop_capture()
        elif command.type == "arm_listen":
            engine.arm_listen()
        elif command.type == "list_devices":
            devices = [d.__dict__ for d in list_input_devices()]
            _emit(encode_json({"event": "device_list", "devices": devices}))
        elif command.type == "calibrate_start":
            engine.start_calibration(CalibrateStartPayload(**command.payload))
        elif command.type == "calibrate_stop":
            engine.stop_calibration()
        elif command.type == "set_threshold":
            engine.set_threshold(SetThresholdPayload(**command.payload).threshold)
        elif command.type == "set_vad":
            engine.set_vad(SetVadPayload(**command.payload).vad)
        elif command.type == "ping":
            _emit(encode_json({"event": "pong", "id": command.id}))
        elif command.type == "shutdown":
            engine.shutdown()
            _emit(encode_json({"event": "stopped"}))
            return False
        else:
            _emit(
                encode_json(
                    {"event": "error", "code": "unknown_command", "detail": command.type}
                )
            )
    except ValidationError as exc:
        _emit(encode_json({"event": "error", "code": "invalid_command", "detail": str(exc)}))
    except Exception as exc:  # a bad command must not kill the process
        _emit(encode_json({"event": "error", "code": "command_failed", "detail": str(exc)}))
    return True


def run(engine: VoiceEngine, stdin: Any, stdout: Any) -> None:
    ready = {"event": "ready", "protocol_version": PROTOCOL_VERSION, "pid": os.getpid()}
    _emit(encode_json(ready))
    reader = FrameReader()
    running = True
    while running:
        # read1 returns as soon as any bytes are available; read(n) would block
        # until the buffer is full, which would stall every short command.
        read = getattr(stdin, "read1", stdin.read)
        chunk = read(4096)
        if not chunk:
            break
        try:
            frames = reader.feed(chunk)
        except ValueError as exc:
            _emit(encode_json({"event": "error", "code": "bad_frame", "detail": str(exc)}))
            break
        for frame_type, payload in frames:
            if frame_type is not FrameType.JSON:
                continue
            try:
                command = Command(**FrameReader.decode_json(payload))
            except Exception as exc:
                _emit(encode_json({"event": "error", "code": "bad_command", "detail": str(exc)}))
                continue
            running = _dispatch(engine, command)
            if not running:
                break
    engine.shutdown()


def main() -> None:
    _pdeathsig()
    diag.info("sidecar starting", protocol_version=PROTOCOL_VERSION)
    engine = build_engine()
    run(engine, sys.stdin.buffer, sys.stdout.buffer)
    diag.info("sidecar exiting")


if __name__ == "__main__":
    main()
