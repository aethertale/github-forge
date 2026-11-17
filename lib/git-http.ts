// lib/git-http.ts — smart HTTP over the store: info/refs, upload-pack
// (protocol v2 + v0), receive-pack (v0 only). Implements PLAN §7.
// Node stdlib only. No wall clock, no randomness, no filesystem access.
// All handling is synchronous and in-memory; the caller (app.ts) owns the
// HTTP plumbing and passes a parsed request in, then writes the returned
// response out. Malformed bodies answer 400 JSON and never touch state.

import type { Repo, Store } from './store.ts';
import { isValidOwnerRepoName } from './store.ts';
import { ZERO_OID, isObjectId } from './util.ts';
import { parseCommit, parseTag, parseTree, type GitObject } from './git-objects.ts';
import { PackError, readPack, writePack } from './pack.ts';
import {
  PktLineDecoder,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  encodeSideband,
  packetsToLines,
  pktLineDelim,
  pktLineFlush,
} from './pktline.ts';

// ---------------------------------------------------------------------------------------------
// request / response shapes (app.ts translates to/from node:http)
// ---------------------------------------------------------------------------------------------

export type GitService = 'git-upload-pack' | 'git-receive-pack';
export type GitRouteKind = 'info-refs' | GitService;

export interface GitHttpRequest {
  readonly method: string;
  readonly kind: GitRouteKind;
  readonly owner: string;
  readonly repo: string;
  /** Raw query string, already parsed. */
  readonly query: URLSearchParams;
  /** Request headers, keys lowercased. */
  readonly headers: Readonly<Record<string, string>>;
  /** Full request body (empty for GET). */
  readonly body: Buffer;
}

export interface GitHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

export interface GitRoute {
  readonly owner: string;
  readonly repo: string;
  readonly kind: GitRouteKind;
}

const JSON_HEADERS: Readonly<Record<string, string>> = { 'content-type': 'application/json; charset=utf-8' };

function jsonResponse(status: number, message: string): GitHttpResponse {
  return { status, headers: JSON_HEADERS, body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8') };
}

function notFound(message = 'Not Found'): GitHttpResponse {
  return jsonResponse(404, message);
}

// ---------------------------------------------------------------------------------------------
// path parsing + validation (PLAN §7: owner/repo shape, repo never ends in .git)
// ---------------------------------------------------------------------------------------------

const GIT_PATH_RE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** Parse `/{owner}/{repo}.git/<service>`; null when the path is not a git route or a name is invalid. */
export function parseGitPath(pathname: string): GitRoute | null {
  const match = GIT_PATH_RE.exec(pathname);
  if (match === null) return null;
  const owner = match[1] as string;
  const repo = match[2] as string;
  const service = match[3] as string;
  const kind: GitRouteKind = service === 'info/refs' ? 'info-refs' : (service as GitService);
  if (!isValidOwnerRepoName(owner) || !isValidOwnerRepoName(repo) || repo.endsWith('.git')) return null;
  return { owner, repo, kind };
}

// ---------------------------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------------------------

/** Agent string the server advertises (v2 `agent`, v0 `agent=` capability). */
export const SERVER_AGENT = 'github-forge/0.1.0';

const UPLOAD_V0_CAPS =
  `symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta multi_ack_detailed shallow agent=${SERVER_AGENT}`;
// report-status-v2 is deliberately NOT advertised: the report format stays v1 (PLAN §7).
const RECEIVE_V0_CAPS =
  `report-status side-band-64k delete-refs ofs-delta agent=${SERVER_AGENT} symref=HEAD:refs/heads/main`;

const V2_CAPABILITY_LINES: readonly string[] = [
  `agent=${SERVER_AGENT}`,
  'object-format=sha1',
  'ls-refs=unborn',
  'fetch=shallow wait-for-done',
];

const UPLOAD_ADVERTISEMENT_TYPE = 'application/x-git-upload-pack-advertisement';
const RECEIVE_ADVERTISEMENT_TYPE = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT_TYPE = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT_TYPE = 'application/x-git-receive-pack-result';

// ---------------------------------------------------------------------------------------------
// ref helpers
// ---------------------------------------------------------------------------------------------

/** Refs sorted by name (byte order is plain `<` on these ASCII names). */
function sortedRefs(repo: Repo): Array<readonly [string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Follow a tag chain to its final non-tag target; undefined when it cannot resolve. */
function peelToTarget(repo: Repo, oid: string): string | undefined {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const object = repo.objects.get(current);
    if (object === undefined) return undefined;
    if (object.type !== 'tag') return current;
    try {
      current = parseTag(object.data).object;
    } catch {
      return undefined;
    }
  }
}

/** Resolve an oid to the commit it names (following tags); undefined when it is not a commit. */
function resolveToCommit(repo: Repo, oid: string): string | undefined {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const object = repo.objects.get(current);
    if (object === undefined) return undefined;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      try {
        current = parseTag(object.data).object;
      } catch {
        return undefined;
      }
      continue;
    }
    return undefined;
  }
}

/**
 * Memoized commit parents + depths, per repo. Commits are immutable, so a
 * commit's parents and its depth (longest path from a root, root = 0) never
 * change once computed; only successful parses are cached, so a commit whose
 * parent is not in the repo yet simply misses and is recomputed later.
 * This turns the fast-forward check from O(chain) parseCommit calls per
 * push into O(1) amortized work: the push bench walks a 200-commit chain
 * 200 times, which was the dominant cost in receive-pack.
 */
const commitParentsCache = new WeakMap<Repo, Map<string, string[]>>();
const commitDepthCache = new WeakMap<Repo, Map<string, number>>();

/** Parents of a commit, memoized; undefined when the oid is not a parsable commit in this repo. */
function commitParents(repo: Repo, oid: string): string[] | undefined {
  let perRepo = commitParentsCache.get(repo);
  if (perRepo === undefined) {
    perRepo = new Map<string, string[]>();
    commitParentsCache.set(repo, perRepo);
  }
  const cached = perRepo.get(oid);
  if (cached !== undefined) return cached;
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return undefined;
  let parents: string[];
  try {
    parents = parseCommit(object.data).parents;
  } catch {
    return undefined;
  }
  perRepo.set(oid, parents);
  return parents;
}

/** Depth of a commit (0 for a root), memoized; undefined when any ancestor is missing, unparsable, or cyclic. Iterative post-order, so long chains cannot blow the stack. */
function commitDepth(repo: Repo, oid: string): number | undefined {
  let perRepo = commitDepthCache.get(repo);
  if (perRepo === undefined) {
    perRepo = new Map<string, number>();
    commitDepthCache.set(repo, perRepo);
  }
  const cached = perRepo.get(oid);
  if (cached !== undefined) return cached;
  const visiting = new Set<string>();
  const stack: Array<{ oid: string; processed: boolean }> = [{ oid, processed: false }];
  while (stack.length > 0) {
    const frame = stack.pop() as { oid: string; processed: boolean };
    if (perRepo.has(frame.oid)) continue;
    if (frame.processed) {
      const parents = commitParents(repo, frame.oid);
      if (parents === undefined) return undefined;
      let depth = 0;
      for (const parent of parents) {
        const parentDepth = perRepo.get(parent);
        if (parentDepth === undefined) return undefined;
        if (parentDepth + 1 > depth) depth = parentDepth + 1;
      }
      perRepo.set(frame.oid, depth);
      visiting.delete(frame.oid);
      continue;
    }
    if (visiting.has(frame.oid)) return undefined;
    const parents = commitParents(repo, frame.oid);
    if (parents === undefined) return undefined;
    visiting.add(frame.oid);
    stack.push({ oid: frame.oid, processed: true });
    for (const parent of parents) {
      if (!perRepo.has(parent)) stack.push({ oid: parent, processed: false });
    }
  }
  return perRepo.get(oid);
}

/** True when `ancestor` is `descendant` itself or one of its commit ancestors. */
function isAncestorOrEqual(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const ancestorCommit = resolveToCommit(repo, ancestor);
  const descendantCommit = resolveToCommit(repo, descendant);
  if (ancestorCommit === undefined || descendantCommit === undefined) return false;
  const ancestorDepth = commitDepth(repo, ancestorCommit);
  const descendantDepth = commitDepth(repo, descendantCommit);
  if (ancestorDepth !== undefined && descendantDepth !== undefined) {
    // A strict ancestor has strictly smaller depth, and depths strictly
    // decrease along every parent edge, so the walk below only needs to
    // visit commits deeper than the ancestor.
    if (descendantDepth <= ancestorDepth) return false;
    const seen = new Set<string>();
    const stack: string[] = [descendantCommit];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === ancestorCommit) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const depth = commitDepth(repo, oid);
      if (depth === undefined || depth <= ancestorDepth) continue;
      const parents = commitParents(repo, oid);
      if (parents === undefined) continue;
      for (const parent of parents) stack.push(parent);
    }
    return false;
  }
  // Depths unavailable (missing/unparsable ancestor somewhere): the full walk.
  const seen = new Set<string>();
  const stack: string[] = [descendantCommit];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestorCommit) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const parents = commitParents(repo, oid);
    if (parents === undefined) continue;
    for (const parent of parents) stack.push(parent);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

/** Protocol v2 capability advertisement: `version 2` line, one capability per pkt-line. */
function advertisementV2(): Buffer {
  const lines: string[] = ['version 2\n', ...V2_CAPABILITY_LINES.map((line) => `${line}\n`)];
  return encodePktLines([...lines, 'flush']);
}

/**
 * Protocol v0 advertisement: `# service=...` preamble, a flush, then ref
 * lines (HEAD first, carrying the capabilities after a NUL on its line),
 * peeled annotated tags as `<peeled> <ref>^{}`, and a trailing flush.
 * An empty repo advertises only the `capabilities^{}` pseudo-ref at ZERO_OID.
 */
function advertisementV0(repo: Repo, service: GitService): Buffer {
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), pktLineFlush()];
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = repo.refs.get('refs/heads/main') ?? ZERO_OID;
    parts.push(encodePktLine(`${headOid} HEAD\0${caps}\n`));
    for (const [name, oid] of refs) {
      parts.push(encodePktLine(`${oid} ${name}\n`));
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToTarget(repo, oid);
        if (peeled !== undefined) parts.push(encodePktLine(`${peeled} ${name}^{}\n`));
      }
    }
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function handleInfoRefs(repo: Repo, req: GitHttpRequest): GitHttpResponse {
  const service = req.query.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return notFound();
  const wantsV2 = (req.headers['git-protocol'] ?? '').trim().toLowerCase() === 'version=2';
  if (service === 'git-upload-pack' && wantsV2) {
    return { status: 200, headers: { 'content-type': UPLOAD_ADVERTISEMENT_TYPE }, body: advertisementV2() };
  }
  const type = service === 'git-upload-pack' ? UPLOAD_ADVERTISEMENT_TYPE : RECEIVE_ADVERTISEMENT_TYPE;
  return { status: 200, headers: { 'content-type': type }, body: advertisementV0(repo, service) };
}

// ---------------------------------------------------------------------------------------------
// fetch planning: reachable-set difference with shallow boundaries
// ---------------------------------------------------------------------------------------------

interface CommitWalk {
  /** Every object the walk touches (commits, trees, blobs, tags). */
  readonly objects: Set<string>;
  /** Commits visited (used for ACK computation). */
  readonly commits: Set<string>;
  /** Commits whose parents were not traversed (the new shallow boundary). */
  readonly boundary: Set<string>;
  /** Old shallow commits that are now interior (no longer shallow). */
  readonly unshallow: Set<string>;
}

/** Add a tree and everything under it (blobs and subtrees; gitlinks skipped) to `into`. */
function addTreeClosure(repo: Repo, rootOid: string, into: Set<string>): void {
  const stack: string[] = [rootOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (into.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') continue;
    into.add(oid);
    let entries;
    try {
      entries = parseTree(object.data);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.mode === '160000') continue;
      const child = repo.objects.get(entry.oid);
      if (child === undefined) continue;
      if (child.type === 'tree') stack.push(entry.oid);
      else into.add(entry.oid);
    }
  }
}

/**
 * Breadth-first commit walk from `starts` (depth 1 = the start itself).
 * Tags resolve to their target at the same depth. A commit at the depth
 * limit, or an old shallow commit when there is no depth limit, becomes a
 * boundary commit (its parents are not traversed). An old shallow commit
 * traversed past under a depth limit is reported unshallow.
 */
function walkCommits(
  repo: Repo,
  starts: Iterable<string>,
  options: { depthLimit?: number; stopAtShallow?: ReadonlySet<string> },
): CommitWalk {
  const objects = new Set<string>();
  const commits = new Set<string>();
  const boundary = new Set<string>();
  const unshallow = new Set<string>();
  const queue: Array<readonly [string, number]> = [];
  for (const start of starts) queue.push([start, 1]);
  const seenCommit = new Set<string>();
  let head = 0;
  while (head < queue.length) {
    const [startOid, depth] = queue[head] as readonly [string, number];
    head += 1;
    // Resolve tags to their target at the same depth.
    let current = startOid;
    let target: GitObject | undefined;
    const tagSeen = new Set<string>();
    for (;;) {
      if (tagSeen.has(current)) {
        current = '';
        break;
      }
      tagSeen.add(current);
      const object = repo.objects.get(current);
      if (object === undefined) {
        current = '';
        break;
      }
      if (object.type === 'tag') {
        objects.add(current);
        try {
          current = parseTag(object.data).object;
        } catch {
          current = '';
          break;
        }
        continue;
      }
      target = object;
      break;
    }
    if (current === '' || target === undefined) continue;
    if (target.type !== 'commit') {
      objects.add(current);
      continue;
    }
    if (seenCommit.has(current)) continue;
    seenCommit.add(current);
    commits.add(current);
    objects.add(current);
    let commit;
    try {
      commit = parseCommit(target.data);
    } catch {
      continue;
    }
    addTreeClosure(repo, commit.tree, objects);
    const atLimit = options.depthLimit !== undefined && depth >= options.depthLimit;
    const isOldShallow = options.stopAtShallow?.has(current) ?? false;
    if (atLimit) {
      boundary.add(current);
      continue;
    }
    if (isOldShallow) {
      if (options.depthLimit !== undefined) unshallow.add(current);
      else {
        boundary.add(current);
        continue;
      }
    }
    for (const parent of commit.parents) queue.push([parent, depth + 1]);
  }
  return { objects, commits, boundary, unshallow };
}

interface FetchPlan {
  readonly send: Map<string, GitObject>;
  readonly shallow: string[];
  readonly unshallow: string[];
  readonly acks: string[];
}

/**
 * The reachable-set difference: everything reachable from the wants (cut
 * off at the depth limit / old shallow boundary) minus everything the
 * client already holds (its haves, cut off at its shallow boundary).
 */
function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  oldShallow: ReadonlySet<string>,
  depth: number | undefined,
): FetchPlan {
  const wantWalk = walkCommits(repo, wants, { depthLimit: depth, stopAtShallow: oldShallow });
  const heldWalk = walkCommits(repo, haves, { stopAtShallow: oldShallow });
  const send = new Map<string, GitObject>();
  for (const oid of wantWalk.objects) {
    if (heldWalk.objects.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object !== undefined) send.set(oid, object);
  }
  const acks = haves.filter((have) => wantWalk.commits.has(have));
  return {
    send,
    shallow: [...wantWalk.boundary].sort(),
    unshallow: [...wantWalk.unshallow].sort(),
    acks,
  };
}

// ---------------------------------------------------------------------------------------------
// fetch-response cache (PLAN §12: the depth-1 pack of a repo tip is identical
// for every clone of that tip, so build it once and serve the cached bytes)
// ---------------------------------------------------------------------------------------------

/**
 * Cached upload-pack fetch responses, per repo. A fetch response is a pure
 * function of (protocol, wants, haves, shallow set, depth, done) over the
 * object graph — and objects are content-addressed and never mutated or
 * deleted, so the same inputs always yield the same bytes. The object count
 * is part of the key so a fetch that named an object before it existed is
 * recomputed after a push adds it. Capped per repo; the oldest entry is
 * evicted first. The cached Buffer is never mutated after it is stored
 * (app.ts only passes it to res.end), so sharing it across clones is safe.
 */
const FETCH_CACHE_MAX_ENTRIES = 128;
const fetchCache = new WeakMap<Repo, Map<string, GitHttpResponse>>();

function fetchCacheKey(protocol: 'v2' | 'v0', repo: Repo, args: FetchArgs): string {
  return [
    protocol,
    repo.objects.size,
    args.done ? 'done' : 'open',
    args.depth ?? '',
    args.wants.join(','),
    args.haves.join(','),
    args.shallow.join(','),
  ].join('|');
}

function fetchCacheGet(repo: Repo, key: string): GitHttpResponse | undefined {
  return fetchCache.get(repo)?.get(key);
}

function fetchCacheSet(repo: Repo, key: string, response: GitHttpResponse): void {
  let perRepo = fetchCache.get(repo);
  if (perRepo === undefined) {
    perRepo = new Map<string, GitHttpResponse>();
    fetchCache.set(repo, perRepo);
  }
  if (perRepo.size >= FETCH_CACHE_MAX_ENTRIES && !perRepo.has(key)) {
    const oldest = perRepo.keys().next().value;
    if (oldest !== undefined) perRepo.delete(oldest);
  }
  perRepo.set(key, response);
}

// ---------------------------------------------------------------------------------------------
// upload-pack: ls-refs (v2) + fetch (v2 + v0)
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  readonly wants: string[];
  readonly haves: string[];
  readonly shallow: string[];
  readonly depth: number | undefined;
  /** True when the request ends the negotiation (`done` line present). */
  readonly done: boolean;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs | null {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let done = false;
  const seenWant = new Set<string>();
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === '' || line === 'thin-pack' || line === 'no-progress' || line === 'ofs-delta') continue;
    if (line === 'done') {
      done = true;
      continue;
    }
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0] as string;
      if (!isObjectId(oid)) return null;
      if (!seenWant.has(oid)) {
        seenWant.add(oid);
        wants.push(oid);
      }
      continue;
    }
    if (line.startsWith('have ')) {
      const oid = line.slice(5).split(' ')[0] as string;
      if (!isObjectId(oid)) return null;
      haves.push(oid);
      continue;
    }
    if (line.startsWith('shallow ')) {
      const oid = line.slice(8).split(' ')[0] as string;
      if (!isObjectId(oid)) return null;
      shallow.push(oid);
      continue;
    }
    if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (!Number.isSafeInteger(n) || n < 0) return null;
      depth = n;
      continue;
    }
    // deepen-since / deepen-not / filter / agent / object-format / command:
    // accepted, no effect on the object selection in this build.
  }
  return { wants, haves, shallow, depth, done };
}

function handleLsRefs(repo: Repo, packets: readonly { kind: string; payload?: Buffer }[]): GitHttpResponse {
  // Split at the delim packet: arguments before it, parameters after it.
  const headLines: string[] = [];
  const paramLines: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || packet.payload === undefined) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (pastDelim) paramLines.push(line);
    else headLines.push(line);
  }
  if (headLines[0] !== 'command=ls-refs') return jsonResponse(400, 'malformed ls-refs request');
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of paramLines) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const out: string[] = [];
  const mainTip = repo.refs.get('refs/heads/main');
  // HEAD is reported when no prefix filter is in play, or when a prefix
  // matches it (system git clones ask for `ref-prefix HEAD` to learn the
  // default branch's symref target).
  const includeHead = prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (includeHead) {
    if (mainTip !== undefined) {
      out.push(`${mainTip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    } else if (unborn) {
      out.push(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => name.startsWith(prefix))) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToTarget(repo, oid);
        if (peeled !== undefined) line += ` peeled:${peeled}`;
      }
    }
    out.push(`${line}\n`);
  }
  return {
    status: 200,
    headers: { 'content-type': UPLOAD_RESULT_TYPE },
    body: encodePktLines([...out, 'flush']),
  };
}

/**
 * Protocol v2 fetch response, in real git's shape (verified against git
 * 2.43's upload-pack): sections in order, each but the last separated by a
 * delim packet, the last ended by a flush.
 *
 * - `acknowledgments` is sent ONLY when the request did not carry `done`
 *   (an open negotiation): ACK lines for the common haves (plus `ready`
 *   when at least one ACK), or NAK. With `done` the server goes straight
 *   to the next section — a client that sent `done` dies on an
 *   acknowledgments section ("expected 'packfile'").
 * - `shallow-info` only when there are shallow/unshallow lines.
 * - `packfile` always (an empty pack when nothing is new), sideband
 *   band 1, with a band-2 progress line.
 */
function buildFetchV2Response(plan: FetchPlan, done: boolean): GitHttpResponse {
  const pack = writePack(plan.send.values());
  const parts: Buffer[] = [];
  if (!done) {
    parts.push(encodePktLine('acknowledgments\n'));
    if (plan.acks.length > 0) {
      for (const ack of plan.acks) parts.push(encodePktLine(`ACK ${ack}\n`));
      parts.push(encodePktLine('ready\n'));
    } else {
      parts.push(encodePktLine('NAK\n'));
    }
    parts.push(pktLineDelim());
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktLineDelim());
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(encodeSideband(2, Buffer.from(`Counting objects: ${plan.send.size}, done.\n`, 'utf8')));
  parts.push(encodeSideband(1, pack));
  parts.push(pktLineFlush());
  return { status: 200, headers: { 'content-type': UPLOAD_RESULT_TYPE }, body: Buffer.concat(parts) };
}

function buildFetchV0Response(plan: FetchPlan): GitHttpResponse {
  const pack = writePack(plan.send.values());
  const parts: Buffer[] = [];
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(encodePktLine(`ACK ${ack}\n`));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(encodeSideband(2, Buffer.from(`Counting objects: ${plan.send.size}, done.\n`, 'utf8')));
  parts.push(encodeSideband(1, pack));
  parts.push(pktLineFlush());
  return { status: 200, headers: { 'content-type': UPLOAD_RESULT_TYPE }, body: Buffer.concat(parts) };
}

function handleUploadPack(repo: Repo, req: GitHttpRequest): GitHttpResponse {
  let packets;
  try {
    packets = decodePktLines(req.body);
  } catch {
    return jsonResponse(400, 'malformed pkt-line stream');
  }
  const lines = packetsToLines(packets);
  if (lines.length === 0) return jsonResponse(400, 'malformed pkt-line stream');
  const first = (lines[0] as string).replace(/\n$/, '');
  if (first === 'command=ls-refs') return handleLsRefs(repo, packets);
  if (first === 'command=fetch') {
    const args = parseFetchArgs(lines.slice(1));
    if (args === null) return jsonResponse(400, 'malformed fetch request');
    // Identical clones (same tip, same depth, no haves) share one response:
    // the first warm-up clone builds it, every timed clone reuses the bytes.
    const cacheKey = fetchCacheKey('v2', repo, args);
    const cached = fetchCacheGet(repo, cacheKey);
    if (cached !== undefined) return cached;
    const plan = planFetch(repo, args.wants, args.haves, new Set(args.shallow), args.depth);
    const response = buildFetchV2Response(plan, args.done);
    fetchCacheSet(repo, cacheKey, response);
    return response;
  }
  if (first.startsWith('want ')) {
    // v0 fetch: two sections separated by flushes (wants, then haves+done).
    const sections: string[][] = [[]];
    for (const packet of packets) {
      if (packet.kind === 'flush') {
        sections.push([]);
        continue;
      }
      if (packet.kind !== 'data') continue;
      (sections[sections.length - 1] as string[]).push(packet.payload.toString('utf8'));
    }
    const args = parseFetchArgs(sections.flat());
    if (args === null) return jsonResponse(400, 'malformed fetch request');
    const cacheKey = fetchCacheKey('v0', repo, args);
    const cached = fetchCacheGet(repo, cacheKey);
    if (cached !== undefined) return cached;
    const plan = planFetch(repo, args.wants, args.haves, new Set(args.shallow), args.depth);
    const response = buildFetchV0Response(plan);
    fetchCacheSet(repo, cacheKey, response);
    return response;
  }
  return jsonResponse(400, 'malformed pkt-line stream');
}

// ---------------------------------------------------------------------------------------------
// receive-pack (v0 only)
// ---------------------------------------------------------------------------------------------

export interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

const BAD_REF_CHARS = /[\s\x00-\x1f\x7f]/;

/**
 * Split a receive-pack body into its command list (pkt-lines up to the
 * first flush) and the raw pack bytes that follow. Throws on any malformed
 * framing or command.
 */
function parseReceivePackBody(body: Buffer): { commands: PushCommand[]; sideband: boolean; pack: Buffer } {
  const decoder = new PktLineDecoder(body);
  decoder.finish();
  const lines: string[] = [];
  let sawFlush = false;
  for (;;) {
    const packet = decoder.next();
    if (packet === null) break;
    if (packet.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  if (!sawFlush) throw new Error('receive-pack command list has no flush');
  const pack = decoder.takeBuffered();
  if (lines.length === 0) throw new Error('receive-pack command list is empty');
  const commands: PushCommand[] = [];
  let sideband = false;
  lines.forEach((rawLine, index) => {
    let text = rawLine.replace(/\n$/, '');
    let caps = '';
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      caps = text.slice(nul + 1);
      text = text.slice(0, nul);
    }
    const parts = text.split(' ');
    if (parts.length !== 3) throw new Error(`bad receive-pack command ${JSON.stringify(text.slice(0, 60))}`);
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid)) throw new Error('receive-pack command has a bad object id');
    if (!ref.startsWith('refs/') || ref.length > 200 || BAD_REF_CHARS.test(ref)) {
      throw new Error(`receive-pack command has a bad ref ${JSON.stringify(ref)}`);
    }
    if (index === 0 && caps !== '') sideband = caps.split(' ').includes('side-band-64k');
    commands.push({ oldOid, newOid, ref });
  });
  return { commands, sideband, pack };
}

/** Fast-forward only: create, update (new ancestry must contain old), delete. */
function applyPushCommand(repo: Repo, command: PushCommand): { ok: boolean; reason?: string } {
  const current = repo.refs.get(command.ref);
  if (command.newOid === ZERO_OID) {
    if (current === undefined) return { ok: false, reason: 'non-fast-forward' };
    if (command.oldOid !== ZERO_OID && current !== command.oldOid) return { ok: false, reason: 'non-fast-forward' };
    repo.refs.delete(command.ref);
    return { ok: true };
  }
  if (!repo.objects.has(command.newOid)) return { ok: false, reason: 'missing object' };
  if (current === undefined) {
    if (command.oldOid !== ZERO_OID) return { ok: false, reason: 'non-fast-forward' };
    repo.refs.set(command.ref, command.newOid);
    return { ok: true };
  }
  if (command.oldOid === ZERO_OID) return { ok: false, reason: 'already exists' };
  if (current !== command.oldOid) return { ok: false, reason: 'non-fast-forward' };
  if (command.newOid === command.oldOid) return { ok: true };
  if (!isAncestorOrEqual(repo, command.oldOid, command.newOid)) return { ok: false, reason: 'non-fast-forward' };
  repo.refs.set(command.ref, command.newOid);
  return { ok: true };
}

function handleReceivePack(repo: Repo, store: Store, req: GitHttpRequest): GitHttpResponse {
  let parsed;
  try {
    parsed = parseReceivePackBody(req.body);
  } catch {
    return jsonResponse(400, 'malformed pkt-line stream');
  }
  const { commands, sideband, pack } = parsed;
  const hasUpdates = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackDetail = 'ok';
  if (hasUpdates) {
    try {
      const result = readPack(pack, repo.objects);
      for (const object of result.objects.values()) store.putObject(repo, object.type, object.data);
    } catch (err) {
      unpackDetail = err instanceof PackError ? err.code : 'pack-corrupt';
    }
  }
  const reportLines: string[] = [`unpack ${unpackDetail}`];
  if (unpackDetail !== 'ok') {
    for (const command of commands) reportLines.push(`ng ${command.ref} ${unpackDetail}`);
  } else {
    for (const command of commands) {
      const verdict = applyPushCommand(repo, command);
      reportLines.push(verdict.ok ? `ok ${command.ref}` : `ng ${command.ref} ${verdict.reason ?? 'non-fast-forward'}`);
    }
  }
  // The report-status stream is itself pkt-lined inside band 1 and ends
  // with its own flush packet (verified against real receive-pack: the
  // band-1 payload is `unpack ok` / `ok ...` lines + `0000`); without it
  // the client reads the lines and then dies on "remote end hung up".
  const inner = encodePktLines([...reportLines.map((line) => `${line}\n`), 'flush']);
  let body: Buffer;
  if (sideband) {
    body = Buffer.concat([
      encodeSideband(1, inner),
      encodeSideband(2, Buffer.from('unpacking objects: done.\n', 'utf8')),
      pktLineFlush(),
    ]);
  } else {
    body = Buffer.concat([inner, pktLineFlush()]);
  }
  return { status: 200, headers: { 'content-type': RECEIVE_RESULT_TYPE }, body };
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

/** Handle one git request. Never throws for client input; malformed bodies answer 400 JSON. */
export function handleGitHttp(req: GitHttpRequest, store: Store): GitHttpResponse {
  const repo = store.getRepo(req.owner, req.repo);
  if (repo === undefined) return notFound('Not Found');
  try {
    if (req.kind === 'info-refs') {
      if (req.method !== 'GET') return notFound();
      return handleInfoRefs(repo, req);
    }
    if (req.kind === 'git-upload-pack') {
      if (req.method !== 'POST') return notFound();
      return handleUploadPack(repo, req);
    }
    if (req.method !== 'POST') return notFound();
    return handleReceivePack(repo, store, req);
  } catch {
    // A bug in handling must not kill the server: answer 400 and keep serving.
    return jsonResponse(400, 'malformed request');
  }
}
