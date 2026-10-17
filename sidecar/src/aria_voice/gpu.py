"""Compute-provider selection for the ONNX runtime.

openWakeWord and Silero are tiny models; on most machines the CPU is as fast as
(or faster than) the GPU because the per-frame kernel is dominated by launch
overhead, not arithmetic. So the default is CPU, and a GPU is only chosen when it
is actually available and the caller asks for it. This module enumerates what
onnxruntime offers and picks a provider without pretending a GPU exists.
"""

from __future__ import annotations

from dataclasses import dataclass

PREFERENCE: tuple[str, ...] = (
    "TensorrtExecutionProvider",
    "CUDAExecutionProvider",
    "ROCMExecutionProvider",
    "DmlExecutionProvider",
    "OpenVINOExecutionProvider",
    "CoreMLExecutionProvider",
    "CPUExecutionProvider",
)

REQUEST_ALIASES: dict[str, str] = {
    "cuda": "CUDAExecutionProvider",
    "tensorrt": "TensorrtExecutionProvider",
    "rocm": "ROCMExecutionProvider",
    "directml": "DmlExecutionProvider",
    "openvino": "OpenVINOExecutionProvider",
    "coreml": "CoreMLExecutionProvider",
    "cpu": "CPUExecutionProvider",
}


@dataclass
class GpuReport:
    available: list[str]
    chosen: list[str]
    reason: str


def available_providers() -> list[str]:
    import onnxruntime as ort

    return list(ort.get_available_providers())


def select_providers(request: str = "auto", available: list[str] | None = None) -> GpuReport:
    """Choose the provider list for a compute request.

    ``auto`` prefers CPU (see the module docstring); an explicit request is
    honoured only when that provider is available, otherwise the choice falls
    back to CPU with a reason that names what was missing.
    """
    providers = available if available is not None else available_providers()
    normalized = (request or "auto").strip().lower()
    if normalized == "auto":
        reason = "auto: CPU is preferred for small models"
        return GpuReport(providers, ["CPUExecutionProvider"], reason)
    wanted = REQUEST_ALIASES.get(normalized, normalized)
    if wanted in providers:
        chain = [wanted] if wanted == "CPUExecutionProvider" else [wanted, "CPUExecutionProvider"]
        return GpuReport(providers, chain, f"requested {wanted}")
    return GpuReport(
        providers,
        ["CPUExecutionProvider"],
        f"{wanted} was requested but is not available",
    )
