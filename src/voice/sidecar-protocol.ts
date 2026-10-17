/**
 * The wire protocol shared with the Python voice sidecar.
 *
 * Transport is stdio. Each frame is a little-endian u32 payload length, a u8
 * frame type, then the payload. Control messages and events are UTF-8 JSON;
 * audio is raw int16 little-endian samples. This mirrors
 * `sidecar/src/aria_voice/protocol.py`; both ends validate, so a malformed or
 * hostile frame is rejected rather than acted on.
 *
 * The sidecar's stdout is untrusted input: it is a separate process and could
 * be a different build. Every event is parsed and bounded by zod before the
 * runtime sees it.
 */

import { z } from 'zod';

/** Must match `PROTOCOL_VERSION` in the Python sidecar. */
export const SIDECAR_PROTOCOL_VERSION = 1;

/** Frame payload cap; a larger declared length is a corrupt or hostile frame. */
export const MAX_FRAME_PAYLOAD = 8 * 1024 * 1024;

export const FrameType = {
  Json: 1,
  Audio: 2,
} as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

const LENGTH_BYTES = 4;
const HEADER_BYTES = LENGTH_BYTES + 1;

export function encodeJsonFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const frame = Buffer.allocUnsafe(HEADER_BYTES + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  frame.writeUInt8(FrameType.Json, LENGTH_BYTES);
  payload.copy(frame, HEADER_BYTES);
  return frame;
}

export function encodeAudioFrame(samples: Buffer): Buffer {
  const frame = Buffer.allocUnsafe(HEADER_BYTES + samples.length);
  frame.writeUInt32LE(samples.length, 0);
  frame.writeUInt8(FrameType.Audio, LENGTH_BYTES);
  samples.copy(frame, HEADER_BYTES);
  return frame;
}

export interface DecodedFrame {
  readonly type: FrameType;
  readonly payload: Buffer;
}

/**
 * Incremental reader for the length-prefixed framing. Feed it arbitrary chunks
 * from stdout; it returns whole frames and retains any partial remainder.
 */
export class SidecarFrameReader {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly maxPayload: number;

  constructor(maxPayload: number = MAX_FRAME_PAYLOAD) {
    this.maxPayload = maxPayload;
  }

  feed(chunk: Buffer): DecodedFrame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: DecodedFrame[] = [];
    while (this.buffer.length >= HEADER_BYTES) {
      const length = this.buffer.readUInt32LE(0);
      if (length > this.maxPayload) {
        throw new Error(`frame length ${length} exceeds the ${this.maxPayload}-byte cap`);
      }
      if (this.buffer.length < HEADER_BYTES + length) break;
      const rawType = this.buffer.readUInt8(LENGTH_BYTES);
      const payload = this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + length);
      this.buffer = this.buffer.subarray(HEADER_BYTES + length);
      frames.push({ type: rawType as FrameType, payload: Buffer.from(payload) });
    }
    return frames;
  }
}

export function decodeJsonFrame(payload: Buffer): unknown {
  return JSON.parse(payload.toString('utf8'));
}

// ---------------------------------------------------------------------------
// Commands (Aria -> sidecar)
// ---------------------------------------------------------------------------

export const SIDECAR_COMMANDS = [
  'configure',
  'start_capture',
  'stop_capture',
  'list_devices',
  'arm_listen',
  'calibrate_start',
  'calibrate_stop',
  'set_threshold',
  'set_vad',
  'shutdown',
  'ping',
] as const;
export type SidecarCommandType = (typeof SIDECAR_COMMANDS)[number];

export interface SidecarCommand {
  readonly id?: string;
  readonly type: SidecarCommandType;
  readonly payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Events (sidecar -> Aria)
// ---------------------------------------------------------------------------

const boundedString = z.string().max(2_000);
const score = z.number().min(0).max(1);

/**
 * Every event the sidecar emits. Unknown events are tolerated (a newer sidecar
 * may add one) but are not acted on; a malformed known event is a typed error.
 */
export const sidecarEventSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('ready'),
    protocol_version: z.number().int(),
    pid: z.number().int().optional(),
  }),
  z.object({ event: z.literal('pong'), id: z.string().nullable().optional() }),
  z.object({ event: z.literal('armed') }),
  z.object({ event: z.literal('stopped') }),
  z.object({
    event: z.literal('wake'),
    model: boundedString,
    score,
    ts: z.number().optional(),
  }),
  z.object({ event: z.literal('speech_start'), vad_prob: score.optional() }),
  z.object({ event: z.literal('speech_end'), samples: z.number().int().nonnegative() }),
  z.object({ event: z.literal('level'), rms: z.number(), peak: z.number() }),
  z.object({
    event: z.literal('scores'),
    model: boundedString,
    score,
  }),
  z.object({
    event: z.literal('device_list'),
    devices: z.array(
      z.object({
        id: z.union([z.string(), z.number()]).optional(),
        name: boundedString.optional(),
        is_default: z.boolean().optional(),
      }),
    ),
  }),
  z.object({
    event: z.literal('device_error'),
    code: boundedString,
    detail: boundedString.optional(),
  }),
  z.object({
    event: z.literal('gpu_report'),
    available: z.array(z.string()).optional(),
    chosen: z.array(z.string()).optional(),
    reason: boundedString.optional(),
    vad_providers: z.array(z.string()).optional(),
  }),
  z.object({
    event: z.literal('calibrating'),
    phase: boundedString,
    seconds: z.number().optional(),
  }),
  z.object({
    event: z.literal('calibration_result'),
    phase: boundedString,
    threshold: score,
    noise_floor: z.number().optional(),
    weakest_positive: z.number().nullable().optional(),
    positives: z.number().int().nonnegative().optional(),
    confidence: boundedString.optional(),
  }),
  z.object({
    event: z.literal('metrics'),
    frames: z.number().int().nonnegative().optional(),
    wakes: z.number().int().nonnegative().optional(),
    utterances: z.number().int().nonnegative().optional(),
  }),
  z.object({
    event: z.literal('error'),
    code: boundedString,
    detail: boundedString.optional(),
  }),
]);

export type SidecarEvent = z.infer<typeof sidecarEventSchema>;

/** Parse a JSON frame into a validated event, or `undefined` when it is not one. */
export function parseSidecarEvent(payload: Buffer): SidecarEvent | undefined {
  let value: unknown;
  try {
    value = decodeJsonFrame(payload);
  } catch {
    return undefined;
  }
  const parsed = sidecarEventSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
