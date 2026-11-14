// lib/pack.ts — pack v2 read + write. Implements PLAN §6.
// Node stdlib only (node:crypto, node:zlib).
//
// READ: header PACK + uint32BE version (2, reader also accepts 3) + uint32BE
// count; per-object type/size varint, zlib payload (inflated length must equal
// the declared size); OFS_DELTA + REF_DELTA resolution, recursive, with cycle
// detection; thin-pack bases resolved from a caller-supplied Map (or lookup
// function); trailer SHA-1 verified (mismatch is an error); stray bytes
// before the trailer are corrupt. Every failure throws PackError.
// WRITE: plain objects, no deltas; deterministic order — commits, then
// trees, then blobs, then tags, each by oid ascending; trailer SHA-1 over
// all preceding bytes.
//
// Delta format: varint source size, varint target size (must equal the base
// length), then opcodes: copy (MSB set; offset bits 0-3, size bits 4-6,
// little-endian; copy size 0 means 0x10000), insert (MSB clear, non-zero =
// literal count), opcode 0 = corrupt.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { hashObject, typeCodeOf, typeOfCode, type GitObject, type GitObjectType } from './git-objects.ts';

/** Error raised for malformed packs/deltas; `code` is machine-readable. */
export class PackError extends Error {
  readonly code: string;

  constructor(message: string, code = 'pack-corrupt') {
    super(message);
    this.name = 'PackError';
    this.code = code;
  }
}

export interface PackEntry {
  /** Byte offset of this entry's header in the pack. */
  readonly offset: number;
  /** Resolved object type (deltas report their base's type). */
  readonly type: GitObjectType;
  /** Declared (inflated) size of the entry's stored payload. */
  readonly size: number;
  /** The stored payload: raw bytes for plain objects, delta bytes for deltas. */
  readonly data: Buffer;
  readonly oid: string;
  readonly delta: { readonly kind: 'ofs' | 'ref'; readonly baseOid: string } | null;
}

export interface PackReadResult {
  readonly version: number;
  readonly declaredCount: number;
  readonly objects: Map<string, GitObject>;
  readonly entries: PackEntry[];
  readonly trailer: string;
  readonly deltaCount: number;
  readonly byteLength: number;
}

export type BaseLookup = Map<string, GitObject> | ((oid: string) => GitObject | undefined);

function lookupBase(bases: BaseLookup | undefined, oid: string): GitObject | undefined {
  if (!bases) return undefined;
  if (bases instanceof Map) return bases.get(oid);
  return bases(oid);
}

/** SHA-1 of every pack byte before the 20-byte trailer. */
export function packChecksum(pack: Uint8Array): string {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack.buffer, pack.byteOffset, pack.byteLength);
  if (buffer.length < 20) throw new PackError('pack is shorter than its trailer', 'pack-truncated');
  return createHash('sha1').update(buffer.subarray(0, buffer.length - 20)).digest('hex');
}

/** Non-throwing trailer check: { ok, expected (computed), actual (stored) }. */
export function verifyPackChecksum(pack: Uint8Array): { ok: boolean; expected: string; actual: string } {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack.buffer, pack.byteOffset, pack.byteLength);
  if (buffer.length < 20) return { ok: false, expected: '', actual: '' };
  const actual = buffer.subarray(buffer.length - 20).toString('hex');
  const expected = packChecksum(buffer);
  return { ok: actual === expected, expected, actual };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
export function inflateAt(buffer: Uint8Array, offset: number): { data: Buffer; next: number } {
  const view = (Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)).subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new PackError(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`, 'pack-zlib');
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new PackError(`zlib stream at offset ${offset} consumed no bytes`, 'pack-zlib');
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = Buffer.isBuffer(base) ? base : Buffer.from(base.buffer, base.byteOffset, base.byteLength);
  const deltaBuffer = Buffer.isBuffer(delta) ? delta : Buffer.from(delta.buffer, delta.byteOffset, delta.byteLength);
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= deltaBuffer.length) throw new PackError('delta size varint is truncated', 'delta-corrupt');
      const byte = deltaBuffer[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new PackError('delta size varint is too long', 'delta-corrupt');
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== baseBuffer.length) {
    throw new PackError(`delta expects a ${sourceSize}-byte base, got ${baseBuffer.length}`, 'delta-base-size');
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new PackError('delta copy offset is truncated', 'delta-corrupt');
          copyOffset += (deltaBuffer[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new PackError('delta copy size is truncated', 'delta-corrupt');
          copySize += (deltaBuffer[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > baseBuffer.length) throw new PackError('delta copy is out of the base', 'delta-corrupt');
      if (written + copySize > targetSize) throw new PackError('delta writes past its target size', 'delta-corrupt');
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > deltaBuffer.length) throw new PackError('delta insert is truncated', 'delta-corrupt');
      if (written + literal > targetSize) throw new PackError('delta writes past its target size', 'delta-corrupt');
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new PackError('delta opcode 0 is invalid', 'delta-corrupt');
    }
  }
  if (written !== targetSize) throw new PackError(`delta produced ${written} of ${targetSize} bytes`, 'delta-size');
  return out;
}

// Read one pack-entry type/size varint: bits 4-6 = type, low 4 bits = size
// low bits, continuation bit set while more size bytes follow; size shifts
// 4, 11, 18, ...; shift > 63 = corrupt.
function readSizeVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new PackError('pack entry has no size header', 'pack-truncated');
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new PackError('pack entry size varint is truncated', 'pack-truncated');
    byte = buffer[offset] as number;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new PackError('pack entry size varint is too long', 'pack-corrupt');
  }
  return { size, next: offset, first };
}

// Read an OFS_DELTA base offset: git's offset varint,
// value = ((value + 1) * 128) + (byte & 0x7f) per continuation byte.
// Returns the distance backwards from the entry's own offset.
function readOfsDistance(buffer: Buffer, start: number): { distance: number; next: number } {
  if (start >= buffer.length) throw new PackError('ofs-delta has no base offset', 'pack-truncated');
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new PackError('ofs-delta base offset is truncated', 'pack-truncated');
    byte = buffer[offset] as number;
    offset += 1;
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { distance: value, next: offset };
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including
 * OFS_DELTA and REF_DELTA. `bases` supplies objects a thin pack leaves out
 * (a Map from oid to object, or a lookup function); a REF_DELTA base that is
 * neither in the pack nor in `bases` is an error. The trailer SHA-1 must
 * match; a mismatch throws.
 */
export function readPack(pack: Uint8Array, bases?: BaseLookup): PackReadResult {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack.buffer, pack.byteOffset, pack.byteLength);
  if (buffer.length < 32) throw new PackError(`pack is ${buffer.length} bytes, too short`, 'pack-truncated');
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new PackError('pack does not start with PACK', 'pack-header');
  }
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new PackError(`unsupported pack version ${version}`, 'pack-version');
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new PackError('pack trailer checksum mismatch', 'pack-checksum');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readSizeVarint(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDistance(buffer, offset);
      offset = base.next;
      if (base.distance <= 0 || base.distance > entryOffset) {
        throw new PackError(`ofs-delta at ${entryOffset} names an invalid base distance ${base.distance}`, 'pack-delta');
      }
      entry.baseOffset = entryOffset - base.distance;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new PackError('ref-delta base id is truncated', 'pack-truncated');
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (typeOfCode(typeCode) === undefined) {
      throw new PackError(`pack entry ${index} has unknown type code ${typeCode}`, 'pack-type');
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new PackError(
        `pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`,
        'pack-size',
      );
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) {
    throw new PackError(`pack has ${trailerStart - offset} stray bytes before its trailer`, 'pack-trailing');
  }

  const entries: PackEntry[] = [];
  const objects = new Map<string, GitObject>();
  const resolving = new Set<number>();
  const resolvedByOid = new Map<string, RawEntry>();

  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved !== undefined && entry.resolvedType !== undefined && entry.oid !== undefined) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) {
      throw new PackError(`delta cycle at pack offset ${entry.offset}`, 'pack-delta-cycle');
    }
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new PackError(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`, 'pack-delta-base');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry !== undefined) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = lookupBase(bases, wanted);
        if (!external) {
          throw new PackError(`ref-delta base ${wanted} is neither in the pack nor supplied by the caller`, 'pack-delta-base');
        }
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = typeOfCode(entry.typeCode) as GitObjectType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  let deltaCount = 0;
  // Pre-pass: resolve every plain entry first, so a REF_DELTA whose base is
  // a plain object later in the pack still finds it in resolvedByOid.
  // (OFS bases are always at a lower offset, so they resolve recursively.)
  for (const entry of raw) {
    if (entry.typeCode !== 6 && entry.typeCode !== 7) resolve(entry);
  }
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
    entries.push({
      offset: entry.offset,
      type: resolved.type,
      size: entry.size,
      data: entry.data,
      oid: resolved.oid,
      delta:
        entry.typeCode === 6
          ? { kind: 'ofs', baseOid: byOffset.get(entry.baseOffset as number)?.oid ?? '' }
          : entry.typeCode === 7
            ? { kind: 'ref', baseOid: entry.baseOid as string }
            : null,
    });
  }

  return { version, declaredCount, objects, entries, trailer, deltaCount, byteLength: buffer.length };
}

// ---------------------------------------------------------------------------------------------
// packfile write
// ---------------------------------------------------------------------------------------------

export interface GitObjectInput {
  readonly type: GitObjectType;
  readonly data: Uint8Array;
  /** Optional precomputed oid; recomputed from type+data when absent. */
  readonly oid?: string;
}

/** Encode one object's pack header: the type/size varint git's pack format uses. */
export function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = typeCodeOf(type);
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

const TYPE_RANK: Readonly<Record<GitObjectType, number>> = { commit: 0, tree: 1, blob: 2, tag: 3 };

/**
 * Build a packfile from plain objects (no deltas). Deterministic order:
 * commits, then trees, then blobs, then tags, each by oid ascending.
 * The trailer is SHA-1 over everything before it.
 */
export function writePack(objects: Iterable<GitObjectInput>): Buffer {
  const list: Array<{ type: GitObjectType; data: Buffer; oid: string }> = [];
  for (const object of objects) {
    const data = Buffer.isBuffer(object.data)
      ? object.data
      : Buffer.from(object.data.buffer, object.data.byteOffset, object.data.byteLength);
    list.push({ type: object.type, data, oid: object.oid ?? hashObject(object.type, data) });
  }
  list.sort((a, b) => {
    const rank = TYPE_RANK[a.type] - TYPE_RANK[b.type];
    if (rank !== 0) return rank;
    return a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0;
  });
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
