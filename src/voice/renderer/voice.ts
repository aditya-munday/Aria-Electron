/**
 * The hidden voice renderer.
 *
 * It is a dumb 16 kHz mono PCM source: the main process tells it when to start
 * and stop capturing, and it streams the samples back over IPC. Detection, the
 * voice sessions, echo cancellation and the confidence floor all stay in the
 * main process, so this file owns only the browser audio plumbing the main
 * process cannot reach — `getUserMedia` and the audio graph.
 *
 * Capturing through the browser (rather than a native recorder) is what makes
 * the microphone work everywhere: no `parec`/`arecord`/`pw-record` dependency,
 * no per-distro device strings. The audio is resampled to 16 kHz here, because
 * an `AudioContext` is free to hand back 44.1 or 48 kHz and the whole pipeline
 * downstream expects 16 kHz mono.
 */

interface VoiceBridge {
  onVoiceCapture(handler: (payload: { sampleRate: number; frameMs: number }) => void): () => void;
  onVoiceStop(handler: () => void): () => void;
  sendVoicePcm(pcm: Int16Array): void;
  reportVoiceStatus(payload: {
    state: 'idle' | 'starting' | 'running' | 'error';
    detail?: string;
  }): void;
}

/** Resample mono PCM with linear interpolation. The detector needs 16 kHz. */
export function resampleMono(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = input[index] ?? 0;
    const b = input[index + 1] ?? a;
    out[i] = a + (b - a) * fraction;
  }
  return out;
}

/** Clamp and convert a float sample in [-1, 1] to a signed 16-bit integer. */
export function toInt16(sample: number): number {
  const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
  return clamped < 0 ? Math.round(clamped * 32_768) : Math.round(clamped * 32_767);
}

/**
 * Accumulate arbitrary-sized render quanta into fixed frames so the main
 * process receives a steady, exact frame size (which its VAD assumes). Samples
 * left over at a stop are dropped: a partial frame would desync the pipeline.
 */
export class FrameAccumulator {
  private readonly frameSize: number;
  private buffer: number[] = [];

  constructor(frameSize: number) {
    this.frameSize = Math.max(1, frameSize);
  }

  push(samples: Float32Array): Float32Array[] {
    const frames: Float32Array[] = [];
    for (let i = 0; i < samples.length; i += 1) this.buffer.push(samples[i] as number);
    while (this.buffer.length >= this.frameSize) {
      const frame = new Float32Array(this.frameSize);
      for (let i = 0; i < this.frameSize; i += 1) frame[i] = this.buffer[i] as number;
      frames.push(frame);
      this.buffer = this.buffer.slice(this.frameSize);
    }
    return frames;
  }

  reset(): void {
    this.buffer = [];
  }
}

/**
 * Owns one microphone capture session. `start` opens the device and streams
 * frames; `stop` tears the graph down and releases the device. Both are
 * idempotent, and a device error is reported to the main process so a dead
 * microphone is observable rather than silent.
 */
export class VoiceCapture {
  private stream: MediaStream | undefined;
  private context: AudioContext | undefined;
  private source: MediaStreamAudioSourceNode | undefined;
  private node: ScriptProcessorNode | undefined;
  private sink: GainNode | undefined;
  private accumulator: FrameAccumulator | undefined;
  private targetRate = 16_000;
  private starting = false;
  /**
   * Bumped on every start and stop. An async start checks it after each await,
   * so a stop (or a newer start) that lands while the device is opening makes
   * the stale attempt abandon its graph instead of racing a second one.
   */
  private generation = 0;

  constructor(
    private readonly report: (pcm: Int16Array) => void,
    private readonly status: (
      state: 'idle' | 'starting' | 'running' | 'error',
      detail?: string,
    ) => void,
  ) {}

  async start(options: { sampleRate: number; frameMs: number }): Promise<void> {
    if (this.stream !== undefined || this.starting) return;
    const generation = (this.generation += 1);
    this.starting = true;
    this.targetRate = options.sampleRate;
    this.status('starting');
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      // A stop (or a newer start) may have arrived while the device was opening.
      if (this.generation !== generation) {
        for (const track of media.getTracks()) track.stop();
        return;
      }
      const context = new AudioContext({ sampleRate: options.sampleRate });
      const source = context.createMediaStreamSource(media);
      // A 2048-sample quantum at 16 kHz is ~128 ms; the accumulator re-chunks
      // it to the exact frame the main process expects.
      const node = context.createScriptProcessor(2048, 1, 1);
      const sink = context.createGain();
      sink.gain.value = 0;
      const accumulator = new FrameAccumulator(
        Math.max(1, Math.round((options.frameMs / 1000) * options.sampleRate)),
      );
      const ratio = context.sampleRate / this.targetRate;
      node.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        const resampled =
          ratio === 1 ? input.slice() : resampleMono(input, context.sampleRate, this.targetRate);
        const frames = accumulator.push(resampled);
        for (const frame of frames) {
          const pcm = new Int16Array(frame.length);
          for (let i = 0; i < frame.length; i += 1) pcm[i] = toInt16(frame[i] as number);
          this.report(pcm);
        }
      };
      source.connect(node);
      node.connect(sink);
      sink.connect(context.destination);
      await context.resume();
      if (this.generation !== generation) {
        // Superseded while resuming: tear the just-built graph down.
        node.onaudioprocess = null;
        try {
          source.disconnect();
          node.disconnect();
          sink.disconnect();
        } catch {
          // Best effort; the graph is being discarded.
        }
        for (const track of media.getTracks()) track.stop();
        await context.close().catch(() => undefined);
        return;
      }
      this.stream = media;
      this.context = context;
      this.source = source;
      this.node = node;
      this.sink = sink;
      this.accumulator = accumulator;
      this.status('running');
    } catch (error) {
      if (this.generation === generation) {
        this.status('error', error instanceof Error ? error.message : 'microphone capture failed');
      }
    } finally {
      if (this.generation === generation) this.starting = false;
    }
  }

  async stop(): Promise<void> {
    const generation = (this.generation += 1);
    this.starting = false;
    const node = this.node;
    const source = this.source;
    const sink = this.sink;
    const context = this.context;
    const stream = this.stream;
    this.node = undefined;
    this.source = undefined;
    this.sink = undefined;
    this.context = undefined;
    this.stream = undefined;
    this.accumulator = undefined;
    if (node !== undefined) node.onaudioprocess = null;
    try {
      source?.disconnect();
      node?.disconnect();
      sink?.disconnect();
    } catch {
      // A partially-built graph is fine to leave; disconnection never throws hard.
    }
    if (stream !== undefined) for (const track of stream.getTracks()) track.stop();
    if (context !== undefined) await context.close().catch(() => undefined);
    // A start that arrived during teardown owns the state now; a trailing idle
    // would make the main process re-issue a start it already has in flight.
    if (this.generation === generation) this.status('idle');
  }
}

const bridge = (globalThis as { aria?: VoiceBridge }).aria;

if (bridge !== undefined) {
  const capture = new VoiceCapture(
    (pcm) => bridge.sendVoicePcm(pcm),
    (state, detail) => bridge.reportVoiceStatus(detail !== undefined ? { state, detail } : { state }),
  );
  bridge.onVoiceCapture((payload) => {
    void capture.start(payload);
  });
  bridge.onVoiceStop(() => {
    void capture.stop();
  });
  // Tell the main process the renderer is loaded and idle, so a capture command
  // sent before this script subscribed is not lost: the main process re-sends
  // `start` on every `idle` while it wants the microphone.
  bridge.reportVoiceStatus({ state: 'idle' });
}
