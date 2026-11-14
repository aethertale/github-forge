// lib/git-objects.ts — git object model: SHA-1 ids, commit/tree/blob/tag
// parse + serialize. Implements PLAN §6. Node stdlib only (node:crypto).
//
// Object id = SHA-1 of `<type> <size>\0` + raw bytes.
// Tree sort: byte order of name, a directory compared as if its name ended
// in '/'. Modes: 100644 file / 40000 dir (no leading zero); 160000 gitlinks
// are parsed and preserved but never followed on reachability walks.

import { createHash } from 'node:crypto';
import { isObjectId } from './util.ts';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

/** Error raised for malformed git objects; `code` is machine-readable. */
export class GitObjectError extends Error {
  readonly code: string;

  constructor(message: string, code = 'object-parse') {
    super(message);
    this.name = 'GitObjectError';
    this.code = code;
  }
}

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function typeCodeOf(type: GitObjectType): number {
  return TYPE_CODE[type];
}

export function typeOfCode(code: number): GitObjectType | undefined {
  return CODE_TYPE[code];
}

/** The loose-object header `<type> <size>\0` that prefixes hashed bytes. */
export function objectHeader(type: GitObjectType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\0`, 'utf8');
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const hash = createHash('sha1');
  hash.update(objectHeader(type, body.length));
  hash.update(body);
  return hash.digest('hex');
}

/** The full loose-object bytes (header + content). */
export function encodeLooseObject(type: GitObjectType, data: Uint8Array): Buffer {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.concat([objectHeader(type, body.length), body]);
}

// ---------------------------------------------------------------------------------------------
// tree
// ---------------------------------------------------------------------------------------------

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/**
 * git's tree-entry sort: byte order of the name, a directory compared as if
 * it ended in '/'. Only mode 40000 (and its zero-padded spelling 040000)
 * counts as a directory for this comparison.
 */
export function compareTreeEntries(
  a: { readonly name: string; readonly mode: string },
  b: { readonly name: string; readonly mode: string },
): number {
  const aIsDir = a.mode === '40000' || a.mode === '040000';
  const bIsDir = b.mode === '40000' || b.mode === '040000';
  const left = Buffer.from(aIsDir ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(bIsDir ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Sort a copy of `entries` the way git sorts tree entries. */
export function sortTreeEntries(entries: ReadonlyArray<TreeEntry>): TreeEntry[] {
  return [...entries].sort(compareTreeEntries);
}

/** Parse a tree object into its entries, in the object's stored order. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new GitObjectError('tree entry has no mode separator', 'tree-parse');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new GitObjectError('tree entry has no name terminator', 'tree-parse');
    if (nul + 21 > buffer.length) throw new GitObjectError('tree entry has a truncated object id', 'tree-parse');
    const mode = buffer.subarray(offset, space).toString('ascii');
    if (mode.length === 0 || !/^[0-7]+$/.test(mode)) {
      throw new GitObjectError(`tree entry mode ${JSON.stringify(mode)} is not octal`, 'tree-parse');
    }
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Build a tree object's bytes from entries; entries are git-sorted. */
export function buildTree(entries: ReadonlyArray<TreeEntry>): Buffer {
  const sorted = sortTreeEntries(entries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!isObjectId(entry.oid)) {
      throw new GitObjectError(`tree entry ${entry.name} has a bad object id`, 'tree-build');
    }
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// commit
// ---------------------------------------------------------------------------------------------

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
  /** Headers before the blank line that are not tree/parent/author/committer, in order. */
  readonly extraHeaders: ReadonlyArray<readonly [string, string]>;
}

export interface BuildCommitFields {
  readonly tree: string;
  readonly parents?: readonly string[];
  readonly message: string;
  /** Identity without timestamp: `Name <email>`. Defaults to the viewer ident. */
  readonly author?: string;
  readonly committer?: string;
  /** Unix seconds. Defaults to the trial time (callers pass an explicit value). */
  readonly timestamp?: number;
  /** `+0000` by default, so two runs produce the same bytes. */
  readonly timezone?: string;
  /** Unknown headers to emit after committer, before the blank line. */
  readonly extraHeaders?: ReadonlyArray<readonly [string, string]>;
}

const COMMIT_IDENT_DEFAULT = 'ada iversen <adaiversen@example.invalid>';

/**
 * Parse a commit object. Continuation lines (starting with a space) belong to
 * the previous header, so a multi-line header such as gpgsig round-trips.
 * Refuses a commit with no valid tree header or a bad parent id.
 */
export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  // Collect raw headers in order first: a line starting with a space is a
  // continuation of the previous header (e.g. a multi-line gpgsig value),
  // so it must append to that header's value, not start a new one.
  const rawHeaders: Array<[string, string]> = [];
  for (const line of headerText.split('\n')) {
    if (line.length === 0) continue;
    if (line.charCodeAt(0) === 0x20 && rawHeaders.length > 0) {
      const last = rawHeaders[rawHeaders.length - 1] as [string, string];
      last[1] = `${last[1]}\n${line}`;
      continue;
    }
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    rawHeaders.push([key, value]);
  }
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  const extra: Array<[string, string]> = [];
  for (const [key, value] of rawHeaders) {
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
    else extra.push([key, value]);
  }
  if (!isObjectId(tree)) throw new GitObjectError('commit has no valid tree header', 'commit-parse');
  for (const parent of parents) {
    if (!isObjectId(parent)) throw new GitObjectError('commit has a bad parent id', 'commit-parse');
  }
  return { tree, parents, author, committer, message, extraHeaders: extra };
}

/**
 * Build a commit object's bytes. Layout: tree, parents, author, committer,
 * extra headers (in given order), blank line, message with a trailing `\n`
 * ensured. Author/committer lines carry `<unixSec> +0000`.
 */
export function buildCommit(fields: BuildCommitFields): Buffer {
  if (!isObjectId(fields.tree)) throw new GitObjectError('buildCommit needs a valid tree id', 'commit-build');
  const parents = fields.parents ?? [];
  for (const parent of parents) {
    if (!isObjectId(parent)) throw new GitObjectError('buildCommit needs valid parent ids', 'commit-build');
  }
  const timestamp = fields.timestamp ?? 1735689600;
  const timezone = fields.timezone ?? '+0000';
  const authorIdent = fields.author ?? COMMIT_IDENT_DEFAULT;
  const committerIdent = fields.committer ?? COMMIT_IDENT_DEFAULT;
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${authorIdent} ${timestamp} ${timezone}`);
  lines.push(`committer ${committerIdent} ${timestamp} ${timezone}`);
  for (const [key, value] of fields.extraHeaders ?? []) lines.push(`${key} ${value}`);
  lines.push('');
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

// ---------------------------------------------------------------------------------------------
// tag
// ---------------------------------------------------------------------------------------------

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
  readonly extraHeaders: ReadonlyArray<readonly [string, string]>;
}

export interface BuildTagFields {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly message: string;
  /** Identity without timestamp: `Name <email>`. Defaults to the viewer ident. */
  readonly tagger?: string;
  readonly timestamp?: number;
  readonly timezone?: string;
}

/** Parse an annotated tag object; unknown headers are kept in extraHeaders. */
export function parseTag(data: Uint8Array): TagView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  const extra: Array<[string, string]> = [];
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new GitObjectError(`tag header ${JSON.stringify(line)} has no value`, 'tag-parse');
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (!headers.has(key)) headers.set(key, value);
    if (key !== 'object' && key !== 'type' && key !== 'tag' && key !== 'tagger') extra.push([key, value]);
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new GitObjectError('tag has no valid object header', 'tag-parse');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new GitObjectError(`tag has bad type ${JSON.stringify(type)}`, 'tag-parse');
  }
  return {
    object,
    type,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
    extraHeaders: extra,
  };
}

/** Build an annotated tag object's bytes; message trailing `\n` ensured. */
export function buildTag(fields: BuildTagFields): Buffer {
  if (!isObjectId(fields.object)) throw new GitObjectError('buildTag needs a valid object id', 'tag-build');
  const timestamp = fields.timestamp ?? 1735689600;
  const timezone = fields.timezone ?? '+0000';
  const taggerIdent = fields.tagger ?? COMMIT_IDENT_DEFAULT;
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${taggerIdent} ${timestamp} ${timezone}\n\n${message}`,
    'utf8',
  );
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

export type ObjectLookup = (oid: string) => GitObject | undefined;

/**
 * Every object reachable from `roots`: commit -> tree + parents, tree ->
 * entries (gitlinks, mode 160000, skipped), tag -> its target, blob -> nothing.
 * Throws GitObjectError('missing-object') on a missing object unless
 * `allowMissing` is set.
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  options: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new GitObjectError(`object ${oid} is missing from the store`, 'missing-object');
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}
