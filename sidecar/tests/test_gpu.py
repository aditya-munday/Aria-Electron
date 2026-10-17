"""Compute-provider selection: auto prefers CPU, explicit requests fall back."""

from __future__ import annotations

from aria_voice import gpu


def test_auto_prefers_cpu() -> None:
    report = gpu.select_providers(
        "auto", available=["CPUExecutionProvider", "CUDAExecutionProvider"]
    )
    assert report.chosen == ["CPUExecutionProvider"]
    assert "CPU" in report.reason


def test_explicit_gpu_is_honoured_when_available() -> None:
    report = gpu.select_providers(
        "cuda", available=["CPUExecutionProvider", "CUDAExecutionProvider"]
    )
    assert report.chosen[0] == "CUDAExecutionProvider"
    assert "CPUExecutionProvider" in report.chosen


def test_explicit_gpu_falls_back_with_a_reason() -> None:
    report = gpu.select_providers("cuda", available=["CPUExecutionProvider"])
    assert report.chosen == ["CPUExecutionProvider"]
    assert "not available" in report.reason


def test_unknown_request_falls_back_to_cpu() -> None:
    report = gpu.select_providers("quantum", available=["CPUExecutionProvider"])
    assert report.chosen == ["CPUExecutionProvider"]


def test_available_providers_reports_cpu_in_this_environment() -> None:
    assert "CPUExecutionProvider" in gpu.available_providers()
