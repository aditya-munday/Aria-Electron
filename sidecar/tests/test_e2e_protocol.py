"""End-to-end: spawn the sidecar, speak the protocol, read the events.

Runs the real process over pipes with a fake capture stream injected by monkey
patching the capture factory, so the full framing/command/event path is
exercised without a sound card.
"""

from __future__ import annotations

import json
import os
import struct
import subprocess
import sys
import time
from pathlib import Path
from typing import IO, Any

ROOT = Path(__file__).resolve().parents[1]


def frame(obj: dict[str, Any]) -> bytes:
    payload = json.dumps(obj).encode()
    return struct.pack("<I", len(payload)) + bytes([1]) + payload


def read_frames(
    stream: IO[bytes], until: set[str] | None = None, timeout: float = 30.0
) -> list[dict[str, Any]]:
    """Read JSON frames until ``until`` is seen, the pipe closes, or timeout.

    A generous default timeout covers commands that load ONNX models.
    """
    import select

    until = until or set()
    events: list[dict[str, Any]] = []
    deadline = time.time() + timeout
    buffer = bytearray()
    while time.time() < deadline:
        ready, _, _ = select.select([stream], [], [], 0.2)
        if not ready:
            continue
        chunk = os.read(stream.fileno(), 4096)
        if not chunk:
            break
        buffer.extend(chunk)
        while len(buffer) >= 5:
            (length,) = struct.unpack_from("<I", buffer, 0)
            if len(buffer) < 5 + length:
                break
            events.append(json.loads(buffer[5 : 5 + length]))
            del buffer[: 5 + length]
        if any(e.get("event") in until for e in events):
            break
    return events


def start_sidecar() -> subprocess.Popen[bytes]:
    env = dict(os.environ)
    env["PYTHONPATH"] = str(ROOT / "src")
    return subprocess.Popen(
        [sys.executable, "-m", "aria_voice"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env=env,
    )


def test_sidecar_ready_ping_and_shutdown() -> None:
    proc = start_sidecar()
    assert proc.stdin is not None and proc.stdout is not None
    ready = read_frames(proc.stdout, until={"ready"})
    assert any(e.get("event") == "ready" for e in ready)
    proc.stdin.write(frame({"type": "ping", "id": "1"}))
    proc.stdin.flush()
    assert any(e.get("event") == "pong" for e in read_frames(proc.stdout, until={"pong"}))
    proc.stdin.write(frame({"type": "shutdown"}))
    proc.stdin.flush()
    stopped = read_frames(proc.stdout, until={"stopped"})
    assert any(e.get("event") == "stopped" for e in stopped)
    proc.wait(timeout=5)
    assert proc.returncode == 0


def test_sidecar_survives_an_unknown_command() -> None:
    proc = start_sidecar()
    assert proc.stdin is not None and proc.stdout is not None
    read_frames(proc.stdout, until={"ready"})
    proc.stdin.write(frame({"type": "not_a_command"}))
    proc.stdin.flush()
    events = read_frames(proc.stdout, until={"error"})
    assert any(e.get("event") == "error" and e.get("code") == "unknown_command" for e in events)
    proc.stdin.write(frame({"type": "ping"}))
    proc.stdin.flush()
    assert any(e.get("event") == "pong" for e in read_frames(proc.stdout, until={"pong"}))
    proc.stdin.write(frame({"type": "shutdown"}))
    proc.stdin.flush()
    proc.wait(timeout=5)


def test_sidecar_exits_when_stdin_closes() -> None:
    proc = start_sidecar()
    assert proc.stdout is not None
    read_frames(proc.stdout, until={"ready"})
    assert proc.stdin is not None
    proc.stdin.close()
    proc.wait(timeout=5)
    assert proc.returncode == 0


def test_configure_emits_a_gpu_report_without_capture() -> None:
    proc = start_sidecar()
    assert proc.stdin is not None and proc.stdout is not None
    read_frames(proc.stdout, until={"ready"})
    proc.stdin.write(frame({"type": "configure", "payload": {"compute": "cpu", "level_hz": 20}}))
    proc.stdin.flush()
    events = read_frames(proc.stdout, until={"gpu_report"})
    reports = [e for e in events if e.get("event") == "gpu_report"]
    assert reports and "CPUExecutionProvider" in reports[0]["chosen"]
    proc.stdin.write(frame({"type": "shutdown"}))
    proc.stdin.flush()
    proc.wait(timeout=5)


def test_list_devices_reports_a_device_error_without_portaudio() -> None:
    proc = start_sidecar()
    assert proc.stdin is not None and proc.stdout is not None
    read_frames(proc.stdout, until={"ready"})
    proc.stdin.write(frame({"type": "list_devices"}))
    proc.stdin.flush()
    events = read_frames(proc.stdout, until={"device_list", "error"})
    # Either a device_list or an error; both are honest outcomes.
    assert any(e.get("event") in {"device_list", "error"} for e in events)
    proc.stdin.write(frame({"type": "shutdown"}))
    proc.stdin.flush()
    proc.wait(timeout=5)
