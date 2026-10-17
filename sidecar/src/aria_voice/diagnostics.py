"""Structured logging to stderr.

stdout carries only protocol frames, so every diagnostic goes to stderr as one
JSON object per line. The parent parses these; a human tailing the log sees the
same lines. Log level is read from ``ARIA_LOG_LEVEL``.
"""

from __future__ import annotations

import json
import os
import sys
import time

_LEVELS = {"debug": 10, "info": 20, "warn": 30, "error": 40}


def _threshold() -> int:
    return _LEVELS.get(os.environ.get("ARIA_LOG_LEVEL", "info").strip().lower(), 20)


def log(level: str, message: str, **fields: object) -> None:
    if _LEVELS.get(level, 20) < _threshold():
        return
    record = {"ts": time.time(), "level": level, "msg": message}
    record.update(fields)
    sys.stderr.write(json.dumps(record, separators=(",", ":")) + "\n")
    sys.stderr.flush()


def debug(message: str, **fields: object) -> None:
    log("debug", message, **fields)


def info(message: str, **fields: object) -> None:
    log("info", message, **fields)


def warn(message: str, **fields: object) -> None:
    log("warn", message, **fields)


def error(message: str, **fields: object) -> None:
    log("error", message, **fields)
