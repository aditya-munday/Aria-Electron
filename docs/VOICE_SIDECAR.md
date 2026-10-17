# The Aria voice sidecar

`aria_voice` is a local Python process that owns the microphone and runs the
wake-word and voice-activity models. It exists for one reason: **isolation**. A
native or model fault in the wake engine (the failure that took down 0.7.6) must
be able to crash *this* process without taking the Electron main process down.

The sidecar is opt-in. The default wake detector is still the dependency-free
JavaScript phrase spotter; `ARIA_WAKE_ENGINE=sidecar` selects the Python engine.

## Process contract

- Transport is stdio. The sidecar reads only stdin and writes protocol frames
  only to stdout; every diagnostic goes to stderr as one JSON object per line.
- It opens no sockets (inbound or outbound) and never invokes a shell.
- On Linux it sets `PR_SET_PDEATHSIG(SIGTERM)`, so it is killed when the parent
  dies even if the parent is `SIGKILL`ed. It also exits when stdin closes.
- The Electron side frames commands, validates every event, and supervises the
  process: a `ready` handshake, a protocol-version check, bounded
  exponential-backoff restart, and a clean `shutdown` on quit.

## Framing

Each frame is a little-endian `u32` payload length, a `u8` frame type, then the
payload:

```
+----------------+-----------+---------------------+
| length (u32le) | type (u8) | payload (length B)  |
+----------------+-----------+---------------------+
```

| Type | Name | Payload |
| --- | --- | --- |
| `1` | JSON | a UTF-8 JSON object |
| `2` | AUDIO | raw int16 little-endian samples (16 kHz mono) |

A declared length above 8 MiB is rejected, so a corrupt or hostile length cannot
make either side allocate unbounded memory. The schema is defined once in
`sidecar/src/aria_voice/protocol.py` and mirrored in
`src/voice/sidecar-protocol.ts`; both ends validate.

## Commands (Aria → sidecar)

| Command | Payload | Effect |
| --- | --- | --- |
| `configure` | `ConfigurePayload` | set models, threshold, confirm/cooldown, VAD, compute |
| `start_capture` / `arm_listen` | — | open the mic and arm wake detection |
| `stop_capture` | — | close the mic and disarm |
| `list_devices` | — | enumerate input devices |
| `calibrate_start` | `{seconds, phase}` | record ambient or positive samples |
| `calibrate_stop` | — | emit a `calibration_result` |
| `set_threshold` | `{threshold}` | change the wake threshold live |
| `set_vad` | `{vad}` | change VAD settings live |
| `ping` | — | liveness check |
| `shutdown` | — | stop capture and exit |

Every command may carry an `id`; an invalid payload produces an `error` event and
never kills the process.

`ConfigurePayload` fields (all optional with defaults): `protocol_version`,
`sample_rate` (16000), `frame_ms` (20), `wake_models` (`["alexa_v0.1"]`),
`wake_model_dir`, `threshold` (0.5), `confirm_frames` (2), `cooldown_ms` (2000),
`vad`, `noise_suppression`, `echo_cancel`, `compute` (`auto`), `emit_scores`,
`level_hz` (20).

`VadSettings`: `threshold` (0.5), `hysteresis` (0.15), `min_speech_ms` (250),
`end_silence_ms` (700), `speech_pad_ms` (100), `pre_roll_ms` (300),
`max_utterance_ms` (15000).

## Events (sidecar → Aria)

| Event | Fields | Meaning |
| --- | --- | --- |
| `ready` | `protocol_version`, `pid` | handshake; must match the TS version |
| `pong` | `id` | reply to `ping` |
| `armed` | — | capture is open and wake detection is on |
| `stopped` | — | shutdown acknowledged |
| `wake` | `model`, `score`, `ts` | a confirmed wake-word detection |
| `speech_start` | `vad_prob` | VAD saw speech begin |
| `speech_end` | `samples` | utterance boundary (followed by an AUDIO frame) |
| `level` | `rms`, `peak` | input level meter |
| `device_list` | `devices[]` | reply to `list_devices` |
| `device_error` | `code`, `detail` | capture failed (e.g. no device) |
| `gpu_report` | `available`, `chosen`, `reason`, `vad_providers` | compute providers |
| `calibrating` | `phase`, `seconds` | calibration started |
| `calibration_result` | `phase`, `threshold`, `noise_floor`, `weakest_positive`, `positives`, `confidence` | recommended threshold |
| `metrics` | `frames`, `wakes`, `utterances` | counters |
| `error` | `code`, `detail` | a command failed (the process stays up) |

An utterance is emitted as a `speech_end` JSON event immediately followed by one
AUDIO frame carrying the int16 samples.

## Compute providers

The models are tiny, so the CPU is usually as fast as a GPU (per-frame kernel
launch overhead dominates). The default is therefore CPU; a GPU provider is only
chosen when it is actually available and `ARIA_COMPUTE` asks for it. Providers
are probed in order: TensorRT, CUDA, ROCm, DirectML, OpenVINO, CoreML, CPU. See
`sidecar/src/aria_voice/gpu.py`.

## Running it by hand

```sh
cd sidecar
uv sync
uv run aria-voice          # reads frames on stdin, writes events on stdout
```

The first `ready` frame is written immediately; send a `configure` then an
`arm_listen` to start. Log level is `ARIA_LOG_LEVEL` (debug/info/warn/error).

## Environment

| Variable | Meaning | Default |
| --- | --- | --- |
| `ARIA_WAKE_ENGINE` | `sidecar` selects this engine; `voxrt` the WASM one; unset = JS | unset |
| `ARIA_SIDECAR_PATH` | Absolute path to the `aria-voice` binary | packaged/dev |
| `ARIA_WAKE_MODEL_DIR` | Directory of user wake models (validated) | bundled |
| `ARIA_COMPUTE` | `auto` \| `cpu` \| `cuda` \| `rocm` \| `directml` \| `openvino` | `auto` |
| `ARIA_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` | `info` |

## Tests

```sh
cd sidecar
uv run ruff check . && uv run mypy && uv run pytest
uv run python bench/eval_wake.py     # false-accept regression gate
```

The TS side has its own tests: `src/voice/sidecar-{protocol,supervisor,wake-detector,path}.test.ts`.
