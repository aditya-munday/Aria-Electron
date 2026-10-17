"""Wire protocol for the Aria voice sidecar.

Transport is stdio. Each frame is a little-endian u32 payload length, a u8 frame
type, then the payload. Control messages and events are JSON objects; audio is
raw int16 little-endian samples. The schema is mirrored on the TypeScript side
(src/voice/sidecar-protocol.ts) and both ends validate, so a malformed frame is
rejected rather than acted on.
"""

from __future__ import annotations

import json
import struct
from enum import IntEnum
from typing import Any, Literal

from pydantic import BaseModel, Field

PROTOCOL_VERSION = 1

_LEN = struct.Struct("<I")


class FrameType(IntEnum):
    JSON = 1
    AUDIO = 2


class CommandType(str):
    CONFIGURE = "configure"
    START_CAPTURE = "start_capture"
    STOP_CAPTURE = "stop_capture"
    LIST_DEVICES = "list_devices"
    ARM_LISTEN = "arm_listen"
    CALIBRATE_START = "calibrate_start"
    CALIBRATE_STOP = "calibrate_stop"
    SET_THRESHOLD = "set_threshold"
    SET_VAD = "set_vad"
    SHUTDOWN = "shutdown"
    PING = "ping"


class VadSettings(BaseModel):
    threshold: float = Field(default=0.5, ge=0.0, le=1.0)
    hysteresis: float = Field(default=0.15, ge=0.0, le=1.0)
    min_speech_ms: int = Field(default=250, ge=0)
    end_silence_ms: int = Field(default=700, ge=0)
    speech_pad_ms: int = Field(default=100, ge=0)
    pre_roll_ms: int = Field(default=300, ge=0)
    max_utterance_ms: int = Field(default=15000, ge=0)


class ConfigurePayload(BaseModel):
    protocol_version: int = PROTOCOL_VERSION
    sample_rate: int = 16000
    frame_ms: int = 20
    wake_models: list[str] = Field(default_factory=lambda: ["alexa_v0.1"])
    wake_model_dir: str | None = None
    threshold: float = Field(default=0.5, ge=0.0, le=1.0)
    confirm_frames: int = Field(default=2, ge=1)
    cooldown_ms: int = Field(default=2000, ge=0)
    vad: VadSettings = Field(default_factory=VadSettings)
    noise_suppression: bool = False
    echo_cancel: bool = False
    compute: str = "auto"
    emit_scores: bool = False
    level_hz: int = 20


class CalibrateStartPayload(BaseModel):
    seconds: float = Field(default=10.0, gt=0.0)
    phase: Literal["ambient", "positive"] = "ambient"


class SetThresholdPayload(BaseModel):
    threshold: float = Field(ge=0.0, le=1.0)


class SetVadPayload(BaseModel):
    vad: VadSettings


class Command(BaseModel):
    id: str | None = None
    type: str
    payload: dict[str, Any] = Field(default_factory=dict)


def encode_frame(frame_type: FrameType, payload: bytes) -> bytes:
    return _LEN.pack(len(payload)) + bytes([frame_type]) + payload


def encode_json(obj: dict[str, Any] | BaseModel) -> bytes:
    data = obj.model_dump(mode="json") if isinstance(obj, BaseModel) else obj
    return encode_frame(FrameType.JSON, json.dumps(data, separators=(",", ":")).encode("utf-8"))


def encode_audio(samples: bytes) -> bytes:
    return encode_frame(FrameType.AUDIO, samples)


class FrameReader:
    """Incremental reader for the length-prefixed framing.

    Feed it arbitrary byte chunks; it yields whole (type, payload) frames. A
    declared length above ``max_payload`` is rejected so a corrupt or hostile
    length cannot make the sidecar allocate unbounded memory.
    """

    def __init__(self, max_payload: int = 8 * 1024 * 1024) -> None:
        self._buffer = bytearray()
        self._max = max_payload

    def feed(self, data: bytes) -> list[tuple[FrameType, bytes]]:
        self._buffer.extend(data)
        frames: list[tuple[FrameType, bytes]] = []
        while True:
            if len(self._buffer) < 5:
                break
            (length,) = _LEN.unpack_from(self._buffer, 0)
            if length > self._max:
                raise ValueError(f"frame length {length} exceeds the {self._max}-byte cap")
            if len(self._buffer) < 5 + length:
                break
            raw_type = self._buffer[4]
            payload = bytes(self._buffer[5 : 5 + length])
            del self._buffer[: 5 + length]
            frames.append((FrameType(raw_type), payload))
        return frames

    @staticmethod
    def decode_json(payload: bytes) -> dict[str, Any]:
        obj = json.loads(payload.decode("utf-8"))
        if not isinstance(obj, dict):
            raise ValueError("a JSON frame must be an object")
        return obj
