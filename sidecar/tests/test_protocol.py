"""Frame the raw header/reader and the JSON codec."""

from __future__ import annotations

import json
import struct

import pytest

from aria_voice.protocol import (
    FrameReader,
    FrameType,
    encode_audio,
    encode_frame,
    encode_json,
)


def test_encode_json_round_trips_through_the_reader() -> None:
    data = encode_json({"event": "ready", "protocol_version": 1})
    reader = FrameReader()
    frames = reader.feed(data)
    assert len(frames) == 1
    frame_type, payload = frames[0]
    assert frame_type is FrameType.JSON
    assert FrameReader.decode_json(payload) == {"event": "ready", "protocol_version": 1}


def test_header_is_length_then_type_little_endian() -> None:
    payload = b"abcd"
    data = encode_frame(FrameType.AUDIO, payload)
    (length,) = struct.unpack_from("<I", data, 0)
    assert length == 4
    assert data[4] == FrameType.AUDIO


def test_reader_handles_split_and_combined_chunks() -> None:
    first = encode_json({"a": 1})
    second = encode_audio(b"\x01\x02\x03\x04")
    combined = first + second
    reader = FrameReader()
    assert reader.feed(combined[:3]) == []
    frames = reader.feed(combined[3:])
    assert [f[0] for f in frames] == [FrameType.JSON, FrameType.AUDIO]
    assert frames[1][1] == b"\x01\x02\x03\x04"


def test_reader_rejects_an_oversized_length() -> None:
    reader = FrameReader(max_payload=8)
    header = struct.pack("<I", 1024) + bytes([FrameType.JSON])
    with pytest.raises(ValueError):
        reader.feed(header)


def test_decode_json_rejects_a_non_object() -> None:
    with pytest.raises(ValueError):
        FrameReader.decode_json(json.dumps([1, 2, 3]).encode())
