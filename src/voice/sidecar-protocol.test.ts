import { describe, expect, it } from 'vitest';

import {
  FrameType,
  MAX_FRAME_PAYLOAD,
  SidecarFrameReader,
  decodeJsonFrame,
  encodeAudioFrame,
  encodeJsonFrame,
  parseSidecarEvent,
  sidecarEventSchema,
} from './sidecar-protocol.js';

function frame(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt32LE(payload.length, 0);
  header.writeUInt8(type, 4);
  return Buffer.concat([header, payload]);
}

describe('encodeJsonFrame', () => {
  it('prefixes the length and type, then the UTF-8 payload', () => {
    const frameBytes = encodeJsonFrame({ type: 'ping' });
    const payload = Buffer.from(JSON.stringify({ type: 'ping' }), 'utf8');
    expect(frameBytes.readUInt32LE(0)).toBe(payload.length);
    expect(frameBytes.readUInt8(4)).toBe(FrameType.Json);
    expect(frameBytes.subarray(5).toString('utf8')).toBe(payload.toString('utf8'));
  });
});

describe('encodeAudioFrame', () => {
  it('marks audio frames with the audio type', () => {
    const samples = Buffer.from([1, 0, 2, 0]);
    const frameBytes = encodeAudioFrame(samples);
    expect(frameBytes.readUInt8(4)).toBe(FrameType.Audio);
    expect(frameBytes.readUInt32LE(0)).toBe(4);
    expect(frameBytes.subarray(5)).toEqual(samples);
  });
});

describe('SidecarFrameReader', () => {
  it('decodes a frame split across two chunks', () => {
    const reader = new SidecarFrameReader();
    const bytes = encodeJsonFrame({ event: 'armed' });
    expect(reader.feed(bytes.subarray(0, 3))).toEqual([]);
    const frames = reader.feed(bytes.subarray(3));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.type).toBe(FrameType.Json);
    expect(decodeJsonFrame(frames[0]!.payload)).toEqual({ event: 'armed' });
  });

  it('decodes two frames delivered in one chunk', () => {
    const reader = new SidecarFrameReader();
    const bytes = Buffer.concat([
      encodeJsonFrame({ event: 'armed' }),
      encodeJsonFrame({ event: 'pong', id: 'x' }),
    ]);
    const frames = reader.feed(bytes);
    expect(frames).toHaveLength(2);
  });

  it('rejects a declared length above the cap', () => {
    const reader = new SidecarFrameReader();
    const hostile = Buffer.alloc(5);
    hostile.writeUInt32LE(MAX_FRAME_PAYLOAD + 1, 0);
    hostile.writeUInt8(FrameType.Json, 4);
    expect(() => reader.feed(hostile)).toThrow(/exceeds/);
  });
});

describe('parseSidecarEvent', () => {
  it('parses a ready event', () => {
    const event = parseSidecarEvent(encodeJsonFrame({ event: 'ready', protocol_version: 1 }).subarray(5));
    expect(event).toEqual({ event: 'ready', protocol_version: 1 });
  });

  it('parses a wake event with a score', () => {
    const event = parseSidecarEvent(
      encodeJsonFrame({ event: 'wake', model: 'alexa_v0.1', score: 0.83, ts: 12 }).subarray(5),
    );
    expect(event).toEqual({ event: 'wake', model: 'alexa_v0.1', score: 0.83, ts: 12 });
  });

  it('returns undefined for malformed JSON', () => {
    expect(parseSidecarEvent(Buffer.from('{not json'))).toBeUndefined();
  });

  it('returns undefined for an unknown event name', () => {
    expect(parseSidecarEvent(Buffer.from(JSON.stringify({ event: 'surprise' })))).toBeUndefined();
  });

  it('rejects an out-of-range wake score', () => {
    const parsed = sidecarEventSchema.safeParse({ event: 'wake', model: 'm', score: 2 });
    expect(parsed.success).toBe(false);
  });

  it('caps an over-long model name', () => {
    const parsed = sidecarEventSchema.safeParse({
      event: 'wake',
      model: 'x'.repeat(2_001),
      score: 0.5,
    });
    expect(parsed.success).toBe(false);
  });

  it('tolerates an optional pid on ready', () => {
    const event = parseSidecarEvent(
      encodeJsonFrame({ event: 'ready', protocol_version: 1, pid: 42 }).subarray(5),
    );
    expect(event).toEqual({ event: 'ready', protocol_version: 1, pid: 42 });
  });
});
