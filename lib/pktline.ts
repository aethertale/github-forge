// lib/pktline.ts — pkt-line framing + sideband demux. Implements PLAN §6.
// Node stdlib only (node:buffer).
//
// pkt-line: 4 ASCII hex digits (lowercase on encode), value = payload + 4.
// 0000 flush, 0001 delim, 0002 response-end. Length 0003 invalid.
// Max total 65520 (payload 65516). Bad headers, over-long lengths and
// truncation are errors, never silent data loss.
//
// Sideband: each pkt-line payload = <band byte><data>; band 1 = data,
// band 2 = progress text, band 3 = fatal server error. Any other band is
// an error.

/** git's LARGE_PACKET_MAX: the largest pkt-line including its 4-byte header. */
export const PKT_LINE_MAX = 65520;
/** The largest pkt-line payload (length minus the 4-byte header). */
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;

/** Error raised for malformed pkt-line streams; `code` is machine-readable. */
export class PktLineError extends Error {
  readonly code: string;

  constructor(message: string, code = 'pktline') {
    super(message);
    this.name = 'PktLineError';
    this.code = code;
  }
}

export type GitPacket =
  | { readonly kind: 'data'; readonly payload: Buffer; readonly raw: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

function asBuffer(value: string | Uint8Array): Buffer {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/** Encode one data packet: 4 lowercase hex length bytes then the payload. */
export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = asBuffer(payload);
  if (data.length > PKT_LINE_MAX_PAYLOAD) {
    throw new PktLineError(
      `pkt-line payload is ${data.length} bytes, over the ${PKT_LINE_MAX_PAYLOAD}-byte maximum`,
      'pktline-too-long',
    );
  }
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktLineResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/** Encode a mixed sequence; 'flush'/'delim'/'response-end' are control packets. */
export function encodePktLines(
  items: ReadonlyArray<string | Uint8Array | 'flush' | 'delim' | 'response-end'>,
): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktLineFlush());
    else if (item === 'delim') parts.push(pktLineDelim());
    else if (item === 'response-end') parts.push(pktLineResponseEnd());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

const HEX4 = /^[0-9a-fA-F]{4}$/;

/**
 * An incremental pkt-line decoder. Push response chunks as they arrive;
 * next() returns a packet when one is complete and null when it needs more
 * bytes. finish() marks the stream ended and refuses trailing bytes, so a
 * truncated packet is an error rather than silent data loss.
 */
export class PktLineDecoder {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private ended = false;

  constructor(initial?: Uint8Array) {
    if (initial && initial.length > 0) this.push(initial);
  }

  get bufferedBytes(): number {
    return this.buffered;
  }

  push(chunk: Uint8Array): void {
    if (this.ended) throw new PktLineError('pkt-line decoder received bytes after finish()', 'pktline-after-end');
    if (chunk.length === 0) return;
    this.chunks.push(asBuffer(chunk));
    this.buffered += chunk.length;
  }

  /** Mark the stream ended. A caller that expects raw trailing bytes takes them before this. */
  finish(): void {
    this.ended = true;
  }

  /** True once the stream is ended and every byte was consumed. */
  get complete(): boolean {
    return this.ended && this.buffered === 0;
  }

  private peek(n: number): Buffer | null {
    if (this.buffered < n) return null;
    const first = this.chunks[0] as Buffer;
    if (first.length >= n) return first.subarray(0, n);
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    for (const chunk of this.chunks) {
      const need = n - filled;
      if (need <= 0) break;
      const take = Math.min(need, chunk.length);
      chunk.copy(out, filled, 0, take);
      filled += take;
    }
    return out;
  }

  private take(n: number): Buffer {
    if (this.buffered < n) throw new PktLineError('pkt-line decoder underrun', 'pktline-underrun');
    const first = this.chunks[0] as Buffer;
    if (first.length >= n) {
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      this.buffered -= n;
      return first.subarray(0, n);
    }
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const chunk = this.chunks[0] as Buffer;
      const need = n - filled;
      if (chunk.length <= need) {
        chunk.copy(out, filled);
        filled += chunk.length;
        this.chunks.shift();
      } else {
        chunk.copy(out, filled, 0, need);
        this.chunks[0] = chunk.subarray(need);
        filled = n;
      }
    }
    this.buffered -= n;
    return out;
  }

  /** True when the next four buffered bytes look like a pkt-line length, not raw data. */
  nextLooksFramed(): boolean {
    if (this.buffered < 4) return false;
    return HEX4.test((this.peek(4) as Buffer).toString('ascii'));
  }

  /** Remove and return every buffered byte (the v0 raw-pack fallback). */
  takeBuffered(): Buffer {
    if (this.buffered === 0) return Buffer.alloc(0);
    const out = Buffer.concat(this.chunks, this.buffered);
    this.chunks = [];
    this.buffered = 0;
    return out;
  }

  /**
   * The next packet, or null when more bytes are needed. Throws on a
   * malformed header or a truncated stream (after finish()), never returns
   * a bogus packet.
   */
  next(): GitPacket | null {
    if (this.buffered < 4) {
      if (this.ended && this.buffered > 0) {
        throw new PktLineError(`truncated pkt-line: ${this.buffered} trailing byte(s)`, 'pktline-truncated');
      }
      return null;
    }
    const header = this.peek(4) as Buffer;
    const headerText = header.toString('ascii');
    if (!HEX4.test(headerText)) {
      throw new PktLineError(`invalid pkt-line length ${JSON.stringify(headerText)}`, 'pktline-header');
    }
    const length = Number.parseInt(headerText, 16);
    if (length === 0) {
      this.take(4);
      return { kind: 'flush' };
    }
    if (length === 1) {
      this.take(4);
      return { kind: 'delim' };
    }
    if (length === 2) {
      this.take(4);
      return { kind: 'response-end' };
    }
    if (length === 3) throw new PktLineError('invalid pkt-line length 0003', 'pktline-header');
    if (length > PKT_LINE_MAX) {
      throw new PktLineError(`pkt-line length ${length} exceeds ${PKT_LINE_MAX}`, 'pktline-too-long');
    }
    if (this.buffered < length) {
      if (this.ended) {
        throw new PktLineError(`truncated pkt-line: ${length} announced, ${this.buffered} available`, 'pktline-truncated');
      }
      return null;
    }
    const raw = this.take(length);
    return { kind: 'data', payload: raw.subarray(4), raw };
  }
}

/**
 * Decode a complete buffer into packets. Refuses trailing bytes: a buffer
 * ending mid-packet, or with bytes that are not a pkt-line, throws.
 * Pass allowTrailing to stop (without error) at the first non-framed bytes,
 * e.g. a raw pack following pkt-lines.
 */
export function decodePktLines(bytes: Uint8Array, options: { allowTrailing?: boolean } = {}): GitPacket[] {
  const decoder = new PktLineDecoder(bytes);
  decoder.finish();
  const packets: GitPacket[] = [];
  for (;;) {
    if (options.allowTrailing && decoder.bufferedBytes > 0 && !decoder.nextLooksFramed()) break;
    const packet = decoder.next();
    if (packet === null) break;
    packets.push(packet);
  }
  return packets;
}

/** The decoded text of every data packet, control packets dropped. */
export function packetsToLines(packets: readonly GitPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  return lines;
}

// ---------------------------------------------------------------------------------------------
// sideband
// ---------------------------------------------------------------------------------------------

export type Sideband = 1 | 2 | 3;

/** One decoded sideband packet: its band and its data bytes (band byte stripped). */
export interface SidebandPacket {
  readonly band: Sideband;
  readonly data: Buffer;
}

/**
 * Encode `data` as sideband packets on `band`, chunked so no pkt-line
 * exceeds the maximum (payload = 1 band byte + up to 65515 data bytes).
 * Returns one Buffer holding the concatenated pkt-lines. Empty data
 * encodes to an empty Buffer (no packet is emitted).
 */
export function encodeSideband(band: Sideband, data: Uint8Array): Buffer {
  if (band !== 1 && band !== 2 && band !== 3) {
    throw new PktLineError(`invalid sideband ${band}`, 'sideband-band');
  }
  const body = asBuffer(data);
  if (body.length === 0) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  const maxChunk = PKT_LINE_MAX_PAYLOAD - 1;
  for (let offset = 0; offset < body.length; offset += maxChunk) {
    const chunk = body.subarray(offset, Math.min(body.length, offset + maxChunk));
    const payload = Buffer.concat([Buffer.from([band]), chunk]);
    parts.push(encodePktLine(payload));
  }
  return Buffer.concat(parts);
}

/** Decode one sideband payload (band byte + data). Any other band is an error. */
export function decodeSidebandPacket(payload: Uint8Array): SidebandPacket {
  const buffer = asBuffer(payload);
  if (buffer.length < 1) throw new PktLineError('empty sideband packet', 'sideband-empty');
  const band = buffer[0] as number;
  if (band !== 1 && band !== 2 && band !== 3) {
    throw new PktLineError(`invalid sideband ${band}`, 'sideband-band');
  }
  return { band: band as Sideband, data: buffer.subarray(1) };
}

export interface SidebandDemux {
  /** Band 1 bytes concatenated, in order. */
  readonly data: Buffer;
  /** Band 2 bytes as UTF-8 text. */
  readonly progress: string;
  /** Band 3 bytes as UTF-8 text (a fatal server error; empty when none). */
  readonly error: string;
}

/**
 * Split data packets into their sideband channels. Control packets are
 * ignored. A packet whose payload is empty, or whose band is not 1/2/3,
 * throws. Note: an empty sideband packet inside a packfile section is a
 * protocol error at the git-http layer, not here — this demux only sees
 * packets it is given.
 */
export function demuxSideband(packets: readonly GitPacket[]): SidebandDemux {
  const dataParts: Buffer[] = [];
  const progressParts: Buffer[] = [];
  const errorParts: Buffer[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const decoded = decodeSidebandPacket(packet.payload);
    if (decoded.band === 1) dataParts.push(decoded.data);
    else if (decoded.band === 2) progressParts.push(decoded.data);
    else errorParts.push(decoded.data);
  }
  return {
    data: Buffer.concat(dataParts),
    progress: Buffer.concat(progressParts).toString('utf8'),
    error: Buffer.concat(errorParts).toString('utf8'),
  };
}
