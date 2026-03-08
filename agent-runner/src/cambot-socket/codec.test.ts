import { describe, it, expect, beforeEach } from 'vitest';
import { encodeFrame, FrameDecoder, FrameSizeError, MAX_FRAME_SIZE } from './codec.js';
import type { SocketFrame } from './types.js';

function makeFrame(overrides: Partial<SocketFrame> = {}): SocketFrame {
  return {
    type: 'test',
    id: 'frame-001',
    payload: { hello: 'world' },
    ...overrides,
  };
}

describe('encodeFrame', () => {
  it('produces a buffer with 4-byte BE length header followed by JSON', () => {
    const frame = makeFrame();
    const buf = encodeFrame(frame);
    const length = buf.readUInt32BE(0);
    const json = buf.subarray(4).toString('utf-8');

    expect(length).toBe(buf.length - 4);
    expect(JSON.parse(json)).toEqual(frame);
  });

  it('throws FrameSizeError for oversized frames', () => {
    const frame = makeFrame({
      payload: { data: 'x'.repeat(MAX_FRAME_SIZE) },
    });

    expect(() => encodeFrame(frame)).toThrow(FrameSizeError);
    try {
      encodeFrame(frame);
    } catch (err) {
      const fse = err as FrameSizeError;
      expect(fse.actual).toBeGreaterThan(MAX_FRAME_SIZE);
      expect(fse.max).toBe(MAX_FRAME_SIZE);
      expect(fse.name).toBe('FrameSizeError');
    }
  });
});

describe('FrameDecoder', () => {
  let decoder: FrameDecoder;

  beforeEach(() => {
    decoder = new FrameDecoder();
  });

  it('round-trips a simple frame through encode/decode', () => {
    const frame = makeFrame();
    const encoded = encodeFrame(frame);
    const frames = decoder.push(encoded);

    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(frame);
  });

  it('round-trips a frame with all optional fields', () => {
    const frame = makeFrame({ replyTo: 'req-123', payload: { nested: { deep: true } } });
    const encoded = encodeFrame(frame);
    const frames = decoder.push(encoded);

    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(frame);
    expect(frames[0].replyTo).toBe('req-123');
  });

  it('reassembles a frame split across two pushes', () => {
    const frame = makeFrame();
    const encoded = encodeFrame(frame);
    const midpoint = Math.floor(encoded.length / 2);

    const first = decoder.push(encoded.subarray(0, midpoint));
    expect(first).toHaveLength(0);

    const second = decoder.push(encoded.subarray(midpoint));
    expect(second).toHaveLength(1);
    expect(second[0]).toEqual(frame);
  });

  it('decodes multiple frames from a single chunk', () => {
    const frame1 = makeFrame({ id: 'f1' });
    const frame2 = makeFrame({ id: 'f2', payload: { num: 42 } });
    const combined = Buffer.concat([encodeFrame(frame1), encodeFrame(frame2)]);

    const frames = decoder.push(combined);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual(frame1);
    expect(frames[1]).toEqual(frame2);
  });

  it('handles a frame split across multiple chunks (byte-by-byte)', () => {
    const frame = makeFrame({ payload: { msg: 'hi' } });
    const encoded = encodeFrame(frame);
    let result: SocketFrame[] = [];

    for (let i = 0; i < encoded.length; i++) {
      result = result.concat(decoder.push(encoded.subarray(i, i + 1)));
    }

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(frame);
  });

  it('throws FrameSizeError when length header exceeds max', () => {
    // Craft a buffer with a length header that exceeds MAX_FRAME_SIZE
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_FRAME_SIZE + 1, 0);

    expect(() => decoder.push(header)).toThrow(FrameSizeError);
  });

  it('throws on malformed JSON', () => {
    const badJson = Buffer.from('not valid json', 'utf-8');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(badJson.length, 0);
    const buf = Buffer.concat([header, badJson]);

    expect(() => decoder.push(buf)).toThrow(SyntaxError);
  });

  it('handles a zero-length payload (empty JSON string)', () => {
    // Zero-length body means 0 bytes of JSON, which is invalid JSON.
    // This tests that we get an error for truly zero-length payloads.
    const header = Buffer.alloc(4);
    header.writeUInt32BE(0, 0);

    expect(() => decoder.push(header)).toThrow();
  });

  it('handles an empty payload object', () => {
    const frame = makeFrame({ payload: {} });
    const encoded = encodeFrame(frame);
    const frames = decoder.push(encoded);

    expect(frames).toHaveLength(1);
    expect(frames[0].payload).toEqual({});
  });

  it('reset() clears the internal buffer', () => {
    const frame = makeFrame();
    const encoded = encodeFrame(frame);
    const midpoint = Math.floor(encoded.length / 2);

    // Push partial data
    decoder.push(encoded.subarray(0, midpoint));

    // Reset, then push the full frame
    decoder.reset();
    const frames = decoder.push(encoded);

    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(frame);
  });

  it('preserves unicode content through round-trip', () => {
    const unicodePayload = {
      emoji: '\u{1F600}\u{1F525}\u{1F680}',
      japanese: '\u3053\u3093\u306B\u3061\u306F',
      arabic: '\u0645\u0631\u062D\u0628\u0627',
      math: '\u221A\u03C0\u00B1\u221E',
    };
    const frame = makeFrame({ payload: unicodePayload });
    const encoded = encodeFrame(frame);
    const frames = decoder.push(encoded);

    expect(frames).toHaveLength(1);
    expect(frames[0].payload).toEqual(unicodePayload);
  });

  it('handles multiple frames with partial last frame', () => {
    const frame1 = makeFrame({ id: 'complete-1' });
    const frame2 = makeFrame({ id: 'complete-2' });
    const frame3 = makeFrame({ id: 'partial-3' });

    const encoded3 = encodeFrame(frame3);
    const partialChunk = Buffer.concat([
      encodeFrame(frame1),
      encodeFrame(frame2),
      encoded3.subarray(0, 6), // only partial header + a couple bytes
    ]);

    const firstBatch = decoder.push(partialChunk);
    expect(firstBatch).toHaveLength(2);
    expect(firstBatch[0].id).toBe('complete-1');
    expect(firstBatch[1].id).toBe('complete-2');

    // Now send the rest of frame3
    const secondBatch = decoder.push(encoded3.subarray(6));
    expect(secondBatch).toHaveLength(1);
    expect(secondBatch[0].id).toBe('partial-3');
  });

  it('handles null payload', () => {
    const frame = makeFrame({ payload: null });
    const encoded = encodeFrame(frame);
    const frames = decoder.push(encoded);

    expect(frames).toHaveLength(1);
    expect(frames[0].payload).toBeNull();
  });

  it('handles array payload', () => {
    const frame = makeFrame({ payload: [1, 'two', { three: 3 }] });
    const encoded = encodeFrame(frame);
    const frames = decoder.push(encoded);

    expect(frames).toHaveLength(1);
    expect(frames[0].payload).toEqual([1, 'two', { three: 3 }]);
  });
});
