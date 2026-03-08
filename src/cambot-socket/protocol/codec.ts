/**
 * Length-prefixed binary framing for the cambot-socket TCP transport.
 *
 * Wire format: [4 bytes uint32 BE length][N bytes JSON utf-8]
 *
 * This is the host-side copy. The agent-runner has its own copy at
 * agent-runner/src/cambot-socket/codec.ts. Keep them in sync.
 *
 * Zero external dependencies beyond Node built-ins.
 */
import type { SocketFrame } from './types.js';

const MAX_FRAME_SIZE = 16 * 1024 * 1024; // 16 MB

/**
 * Encode a single SocketFrame into a length-prefixed buffer.
 */
export function encodeFrame(frame: SocketFrame): Buffer {
  const json = Buffer.from(JSON.stringify(frame), 'utf-8');
  if (json.length > MAX_FRAME_SIZE) {
    throw new FrameSizeError(json.length, MAX_FRAME_SIZE);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(json.length, 0);
  return Buffer.concat([header, json]);
}

/**
 * Streaming decoder that reassembles length-prefixed frames from
 * arbitrary TCP chunk boundaries.
 */
export class FrameDecoder {
  private buffer = Buffer.alloc(0);

  /**
   * Push a chunk of data and return any complete frames decoded from
   * the accumulated buffer.
   */
  push(chunk: Buffer): SocketFrame[] {
    this.buffer =
      this.buffer.length === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.buffer, chunk]);
    const frames: SocketFrame[] = [];

    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > MAX_FRAME_SIZE) {
        throw new FrameSizeError(length, MAX_FRAME_SIZE);
      }
      if (this.buffer.length < 4 + length) break;

      const json = this.buffer.subarray(4, 4 + length).toString('utf-8');
      this.buffer = this.buffer.subarray(4 + length);
      frames.push(JSON.parse(json) as SocketFrame);
    }

    // Compact: if we consumed everything, release the buffer reference
    if (this.buffer.length === 0) {
      this.buffer = Buffer.alloc(0);
    }

    return frames;
  }

  /** Discard any buffered partial data. */
  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}

/**
 * Thrown when a frame exceeds the maximum allowed size.
 */
export class FrameSizeError extends Error {
  constructor(
    public readonly actual: number,
    public readonly max: number,
  ) {
    super(`Frame exceeds max size: ${actual} > ${max}`);
    this.name = 'FrameSizeError';
  }
}

export { MAX_FRAME_SIZE };
