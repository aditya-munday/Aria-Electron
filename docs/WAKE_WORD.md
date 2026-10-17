# Wake word: defaults, calibration and the eval harness

Aria detects its wake word locally, in the Python voice sidecar
(`sidecar/src/aria_voice`). This document records the shipped defaults, the
target they are held to, the measured result on the committed fixtures, and how
to calibrate a threshold for a specific user, microphone and room.

## The wake model

- Engine: [openWakeWord](https://github.com/dscripka/openWakeWord), ONNX
  inference framework (portable; no tflite-runtime).
- Bundled model: `alexa_v0.1`. The openWakeWord package ships the `alexa`
  model under the file name `alexa_v0.1.onnx`; the registry resolves either
  spelling, so the default in `protocol.py` is `["alexa_v0.1"]`.
- Auxiliary models (melspectrogram, embedding) ship inside the openWakeWord
  package and are loaded from there; nothing is downloaded at runtime.
- Licensing: the code is Apache-2.0, but the pre-trained models (including
  "alexa") are CC BY-NC-SA 4.0. See `THIRD_PARTY_NOTICES.md`. "Alexa" is a
  third-party trademark and is presented as a selectable model name only; the
  intended product wake word is a custom-trained "Hey Aria" model, which the
  registry already supports with no code change.

## Shipped defaults

| Setting | Default | Notes |
| --- | --- | --- |
| `threshold` | 0.5 | score at or above which a frame counts toward a detection |
| `confirm_frames` (K) | 2 | consecutive 80 ms frames above threshold |
| `cooldown_ms` | 2000 | suppression window after a detection |
| frame cadence | 1280 samples (80 ms) @ 16 kHz | openWakeWord's native window |
| Silero VAD window | 512 samples (32 ms) @ 16 kHz | speech threshold 0.5 |

## Target and measured result

**Target:** zero false accepts per hour on the committed negative fixtures while
keeping the model's own detection intact. FRR (false-rejection rate) is only
meaningful with real positives, which cannot be shipped (a real "Alexa"
recording is neither licensable nor a fair benchmark if synthesised).

Measured with `uv run python bench/eval_wake.py` (four committed negatives:
noise, a 440 Hz tone, fan-like low-pass noise, and music; 3 s each):

| threshold | confirm | cooldown_ms | FRR | false-accepts/hour |
| --- | --- | --- | --- | --- |
| 0.40 | 1 | 1500 | n/a (no positives) | 0.00 |
| 0.40 | 1 | 2000 | n/a | 0.00 |
| 0.40 | 2 | 1500 | n/a | 0.00 |
| 0.40 | 2 | 2000 | n/a | 0.00 |
| 0.40 | 3 | 1500 | n/a | 0.00 |
| 0.40 | 3 | 2000 | n/a | 0.00 |
| 0.50 | 1 | 1500 | n/a | 0.00 |
| 0.50 | 1 | 2000 | n/a | 0.00 |
| 0.50 | 2 | 1500 | n/a | 0.00 |
| 0.50 | 2 | 2000 | n/a | 0.00 |
| 0.50 | 3 | 1500 | n/a | 0.00 |
| 0.50 | 3 | 2000 | n/a | 0.00 |
| 0.60 | 1 | 1500 | n/a | 0.00 |
| 0.60 | 1 | 2000 | n/a | 0.00 |
| 0.60 | 2 | 1500 | n/a | 0.00 |
| 0.60 | 2 | 2000 | n/a | 0.00 |
| 0.60 | 3 | 1500 | n/a | 0.00 |
| 0.60 | 3 | 2000 | n/a | 0.00 |
| 0.70 | 1 | 1500 | n/a | 0.00 |
| 0.70 | 1 | 2000 | n/a | 0.00 |
| 0.70 | 2 | 1500 | n/a | 0.00 |
| 0.70 | 2 | 2000 | n/a | 0.00 |
| 0.70 | 3 | 1500 | n/a | 0.00 |
| 0.70 | 3 | 2000 | n/a | 0.00 |

The shipped defaults (0.50 / 2 / 2000) produce **zero false accepts** on the
negatives; CI fails (`bench/eval_wake.py` exits non-zero) if that regresses.
FRR stays unmeasured until a user supplies real positives; the harness reports
`n/a` rather than inventing a number from synthetic speech.

To measure FRR on your own recordings, drop 16 kHz mono WAVs into
`sidecar/tests/fixtures/wake/` named `pos_*.wav` (wake word) and `neg_*.wav`
(anything that must not wake) and re-run the harness. Do not use
TTS-generated positives to claim real-world accuracy; label such fixtures.

## Calibration (per user, mic and room)

There is no universal "perfect" threshold. The sidecar exposes
`calibrate_start` / `calibrate_stop` and a recommended value:

1. Record ~10 s of ambient noise; track the maximum wake score = noise floor.
2. Prompt the user to say the wake word 5-8 times at normal and far distance;
   record the peak score of each.
3. Recommend a threshold between the noise floor plus a margin and a fraction
   of the weakest positive, clamped to [0.30, 0.90]. Report the estimated miss
   rate and a conservative false-accepts-per-hour estimate.

Sensitivity presets map to thresholds (Strict / Balanced / Sensitive) with the
raw value in Advanced. Default preset: Balanced, near 0.5, validated by the
harness above.
