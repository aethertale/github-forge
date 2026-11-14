// lib/rest.ts — GitHub REST v3 (PLAN §8). All routes operate on the shared
// store, so a repo/issue/PR created here reads back identically over
// git/GraphQL/MCP. Node stdlib only; no wall clock, no randomness, no fs.
// Every timestamp comes from MAKEFUN_TRIAL_NOW (via util.ts).

import type { Repo, Store } from './store.ts';
import { buildCommit, buildTree, parseCommit, parseTag, parseTree, type TreeEntry } from './git-objects.ts';
import { TRIAL_NOW_ISO, TRIAL_NOW_SEC, VIEWER_EMAIL, VIEWER_LOGIN, VIEWER_NAME, isObjectId } from './util.ts';

/** The viewer's numeric id (PLAN §4). */
const VIEWER_ID = 1000;

export interface RestRequest {
  readonly method: string;
  /** Decoded path segments (no leading '/api/v3' — see handleRest). */
  readonly segments: string[];
  readonly query: URLSearchParams;
  /** Raw request body bytes (empty when the request carried none). */
  readonly body: Buffer;
  /** Absolute origin of this server, e.g. "http://127.0.0.1:1234" (Link headers). */
  readonly origin: string;
}

export interface RestResult {
  readonly status: number;
  /** Undefined body = no body at all (used by 204). */
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

type JsonObject = Record<string, unknown>;

function message(status: number, text: string): RestResult {
  return { status, body: { message: text } };
}

function notFound(text = 'Not Found'): RestResult {
  return message(404, text);
}

/** Parse a JSON request body; malformed JSON -> 400 (PLAN §3). */
function parseBody(req: RestRequest): { ok: true; json: JsonObject } | { ok: false; result: RestResult } {
  if (req.body.length === 0) return { ok: true, json: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body.toString('utf8'));
  } catch {
    return { ok: false, result: message(400, 'Malformed JSON body') };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, result: message(400, 'Request body must be a JSON object') };
  }
  return { ok: true, json: parsed as JsonObject };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// ---------------------------------------------------------------------------------------------
// pagination (GitHub-style Link header, same-origin absolute URLs)
// ---------------------------------------------------------------------------------------------

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = Number(query.get('per_page'));
  const pageRaw = Number(query.get('page'));
  const perPage = Number.isFinite(perPageRaw) && perPageRaw >= 1 ? Math.min(Math.trunc(perPageRaw), 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.trunc(pageRaw) : 1;
  return { perPage, page };
}

/** Slice `items` to one page and build the Link header (null when a single page). */
function paginate<T>(items: readonly T[], query: URLSearchParams, origin: string, path: string): { pageItems: T[]; link: string | null } {
  const { perPage, page } = pageParams(query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  if (totalPages <= 1) return { pageItems, link: null };
  const urlFor = (p: number): string => {
    const params = new URLSearchParams(query);
    params.set('per_page', String(perPage));
    params.set('page', String(p));
    return `${origin}${path}?${params.toString()}`;
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${urlFor(page - 1)}>; rel="prev"`);
  parts.push(`<${urlFor(1)}>; rel="first"`);
  parts.push(`<${urlFor(totalPages)}>; rel="last"`);
  return { pageItems, link: parts.join(', ') };
}

function withLink(result: RestResult, link: string | null): RestResult {
  if (link === null) return result;
  return { ...result, headers: { ...(result.headers ?? {}), Link: link } };
}

// ---------------------------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------------------------

function repoJson(repo: Repo): JsonObject {
  return {
    id: repo.databaseId,
    node_id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueJson(issue: import('./store.ts').Issue): JsonObject {
  return {
    id: issue.number,
    node_id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    created_at: TRIAL_NOW_ISO,
    updated_at: TRIAL_NOW_ISO,
  };
}

function pullJson(pull: import('./store.ts').PullRequest): JsonObject {
  return {
    id: pull.number,
    node_id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head.ref, sha: pull.head.sha },
    base: { ref: pull.base.ref, sha: pull.base.sha },
    created_at: TRIAL_NOW_ISO,
    updated_at: TRIAL_NOW_ISO,
  };
}

// ---------------------------------------------------------------------------------------------
// git helpers (trees, commits, refs)
// ---------------------------------------------------------------------------------------------

/** Resolve a branch name, full ref, tag, or commit oid to a commit oid. */
function resolveToCommitOid(repo: Repo, ref: string): string | undefined {
  if (isObjectId(ref)) {
    const object = repo.objects.get(ref);
    if (object === undefined) return undefined;
    if (object.type === 'commit') return ref;
    if (object.type === 'tag') {
      try {
        return resolveToCommitOid(repo, parseTag(object.data).object);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
  const direct = repo.refs.get(ref);
  if (direct !== undefined) return resolveToCommitOid(repo, direct);
  const head = repo.refs.get(`refs/heads/${ref}`);
  if (head !== undefined) return resolveToCommitOid(repo, head);
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) return resolveToCommitOid(repo, tag);
  return undefined;
}

/** Tip commit oid of a branch (bare name), or undefined when the branch is unborn/absent. */
function branchTip(repo: Repo, branch: string): string | undefined {
  const oid = repo.refs.get(`refs/heads/${branch}`);
  if (oid === undefined) return undefined;
  return resolveToCommitOid(repo, oid);
}

/** Tree oid of a commit, or undefined. */
function commitTree(repo: Repo, commitOid: string): string | undefined {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return undefined;
  try {
    return parseCommit(object.data).tree;
  } catch {
    return undefined;
  }
}

function treeEntries(repo: Repo, treeOid: string | undefined): TreeEntry[] {
  if (treeOid === undefined) return [];
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return [];
  try {
    return parseTree(object.data);
  } catch {
    return [];
  }
}

/** Commit message with the single trailing newline buildCommit adds stripped. */
function commitMessageOf(repo: Repo, commitOid: string): string {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return '';
  try {
    const message = parseCommit(object.data).message;
    return message.endsWith('\n') ? message.slice(0, -1) : message;
  } catch {
    return '';
  }
}

/** Walk commits from `tip` (pre-order, first-parent-first, visited once). */
function walkCommitList(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    out.push(oid);
    let parents: string[] = [];
    try {
      parents = parseCommit(object.data).parents;
    } catch {
      parents = [];
    }
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
  }
  return out;
}

/** Every commit reachable from `tip`. */
function ancestorSet(repo: Repo, tip: string): Set<string> {
  return new Set(walkCommitList(repo, tip));
}

/**
 * Insert/replace `segments` in the tree at `treeOid` (null = empty tree) with
 * a file entry for `blobOid`; returns the new tree oid.
 */
function setPathInTree(store: Store, repo: Repo, treeOid: string | null, segments: readonly string[], blobOid: string): string {
  const entries = treeOid === null ? [] : treeEntries(repo, treeOid);
  const [head, ...rest] = segments as [string, ...string[]];
  const next: TreeEntry[] = [...entries];
  const index = next.findIndex((entry) => entry.name === head);
  if (rest.length === 0) {
    const entry: TreeEntry = { mode: '100644', name: head, oid: blobOid };
    if (index >= 0) next[index] = entry;
    else next.push(entry);
  } else {
    const existing = index >= 0 ? next[index] : undefined;
    const subOid = existing !== undefined && existing.mode === '40000' ? existing.oid : null;
    const newSub = setPathInTree(store, repo, subOid, rest, blobOid);
    const entry: TreeEntry = { mode: '40000', name: head, oid: newSub };
    if (index >= 0) next[index] = entry;
    else next.push(entry);
  }
  return store.putObject(repo, 'tree', buildTree(next));
}

/**
 * Remove `segments` from the tree at `treeOid`. Returns the new tree oid, or
 * null when the tree becomes empty (so the caller can prune the parent entry).
 */
function removePathFromTree(store: Store, repo: Repo, treeOid: string, segments: readonly string[]): string | null {
  const entries = treeEntries(repo, treeOid);
  const [head, ...rest] = segments as [string, ...string[]];
  const index = entries.findIndex((entry) => entry.name === head);
  if (index < 0) return treeOid;
  const next: TreeEntry[] = [...entries];
  if (rest.length === 0) {
    next.splice(index, 1);
  } else {
    const existing = next[index] as TreeEntry;
    if (existing.mode !== '40000') return treeOid;
    const sub = removePathFromTree(store, repo, existing.oid, rest);
    if (sub === null) next.splice(index, 1);
    else next[index] = { mode: '40000', name: head, oid: sub };
  }
  if (next.length === 0) return null;
  return store.putObject(repo, 'tree', buildTree(next));
}

/** Look a path up in a tree: the entry at the end, or undefined. */
function lookupPath(repo: Repo, treeOid: string | undefined, segments: readonly string[]): TreeEntry | undefined {
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const entries = treeEntries(repo, current);
    const entry = entries.find((item) => item.name === segments[i]);
    if (entry === undefined) return undefined;
    if (i === segments.length - 1) return entry;
    if (entry.mode !== '40000') return undefined;
    current = entry.oid;
  }
  return undefined;
}

/** Flatten a tree to path -> {oid, mode} (gitlinks skipped). */
function flattenTree(repo: Repo, treeOid: string | undefined, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
  for (const entry of treeEntries(repo, treeOid)) {
    if (entry.mode === '160000') continue;
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
}

/** Build a commit on `branchRef` (creating the branch when absent) and move the ref. */
function commitOnBranch(store: Store, repo: Repo, branch: string, treeOid: string, messageText: string): string {
  const tip = branchTip(repo, branch);
  const parents = tip === undefined ? [] : [tip];
  const commitOid = store.putObject(
    repo,
    'commit',
    buildCommit({ tree: treeOid, parents, message: messageText, timestamp: TRIAL_NOW_SEC }),
  );
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return commitOid;
}

// ---------------------------------------------------------------------------------------------
// line diff (pull files)
// ---------------------------------------------------------------------------------------------

function textLines(buffer: Buffer): string[] {
  if (buffer.length === 0) return [];
  const lines = buffer.toString('utf8').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function isBinary(buffer: Buffer): boolean {
  return buffer.includes(0);
}

/** LCS-based line diff; falls back to whole-file counts for very large inputs. */
function diffLineCounts(oldBuffer: Buffer | undefined, newBuffer: Buffer | undefined): { additions: number; deletions: number } {
  const oldLines = oldBuffer === undefined ? [] : textLines(oldBuffer);
  const newLines = newBuffer === undefined ? [] : textLines(newBuffer);
  if ((oldBuffer !== undefined && isBinary(oldBuffer)) || (newBuffer !== undefined && isBinary(newBuffer))) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > 250_000) return { additions: m, deletions: n };
  // LCS lengths, two rows.
  let prev = new Array<number>(m + 1).fill(0);
  let cur = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    cur[0] = 0;
    for (let j = 1; j <= m; j += 1) {
      cur[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  const common = prev[m] as number;
  return { additions: m - common, deletions: n - common };
}

// ---------------------------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------------------------

export function handleRest(req: RestRequest, store: Store): RestResult {
  const { method, segments } = req;

  // Bodies are parsed once, up front: malformed JSON is a 400 on any route
  // that carries a body (PLAN §3, protocol.malformed-body-400).
  let body: JsonObject = {};
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    const parsed = parseBody(req);
    if (!parsed.ok) return parsed.result;
    body = parsed.json;
  }

  // GET /api/v3/user — the token's login (PLAN §4).
  if (method === 'GET' && segments.length === 1 && segments[0] === 'user') {
    return {
      status: 200,
      body: { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' },
    };
  }

  // /api/v3/user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') return createRepo(store, body);
    if (method === 'GET') {
      const repos = store.listReposByOwner(VIEWER_LOGIN);
      const path = '/api/v3/user/repos';
      const { pageItems, link } = paginate(
        repos.map((repo) => ({ name: repo.name })),
        req.query,
        req.origin,
        path,
      );
      return withLink({ status: 200, body: pageItems }, link);
    }
    return notFound();
  }

  // Everything below is /api/v3/repos/{owner}/{repo}[...]
  if (segments.length < 3 || segments[0] !== 'repos') return notFound();
  const owner = segments[1] as string;
  const repoName = segments[2] as string;
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFound('Not Found');
  const rest = segments.slice(3);
  const repoPath = `/api/v3/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`;

  // /api/v3/repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(repo) };
    if (method === 'PATCH') {
      const description = body.description;
      if (typeof description === 'string') repo.description = description;
      return { status: 200, body: repoJson(repo) };
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      return { status: 204 };
    }
    return notFound();
  }

  const head = rest[0] as string;

  // POST /git/refs — create a branch (or tag ref) at an existing commit.
  if (head === 'git' && rest.length === 2 && rest[1] === 'refs' && method === 'POST') {
    const ref = asString(body.ref);
    const sha = asString(body.sha);
    if (!ref.startsWith('refs/') || !isObjectId(sha)) return notFound('Not Found');
    const target = resolveToCommitOid(repo, sha);
    if (target === undefined) return notFound('Not Found');
    repo.refs.set(ref, sha);
    return { status: 201, body: { ref, object: { sha } } };
  }

  // GET /branches
  if (head === 'branches' && rest.length === 1 && method === 'GET') {
    const branches = store.listBranches(repo).map((name) => ({
      name,
      commit: { sha: repo.refs.get(`refs/heads/${name}`) ?? '' },
    }));
    return { status: 200, body: branches };
  }

  // GET /commits[?sha=<ref>]
  if (head === 'commits' && rest.length === 1 && method === 'GET') {
    const shaParam = req.query.get('sha');
    let tip: string | undefined;
    if (shaParam === null) {
      tip = branchTip(repo, repo.defaultBranch);
    } else {
      tip = resolveToCommitOid(repo, shaParam);
      if (tip === undefined) return notFound('Not Found');
    }
    if (tip === undefined) return { status: 200, body: [] };
    const commits = walkCommitList(repo, tip).map((sha) => ({
      sha,
      commit: { message: commitMessageOf(repo, sha) },
    }));
    return { status: 200, body: commits };
  }

  // /contents/{path...}
  if (head === 'contents' && rest.length >= 2) {
    const pathSegments = rest.slice(1);
    if (method === 'PUT') return putContents(store, repo, pathSegments, body);
    if (method === 'GET') return getContents(repo, pathSegments, req.query.get('ref'));
    if (method === 'DELETE') return deleteContents(store, repo, pathSegments, body);
    return notFound();
  }

  // POST /labels
  if (head === 'labels' && rest.length === 1 && method === 'POST') {
    const name = asString(body.name);
    const color = asString(body.color);
    if (name === '') return message(422, 'Label name is required');
    const label = store.createLabel(repo, name, color);
    return { status: 201, body: { name: label.name, color: label.color } };
  }

  // /issues
  if (head === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') return createIssue(store, repo, body);
      if (method === 'GET') return listIssues(store, repo, req, repoPath);
      return notFound();
    }
    const issueNumber = Number(rest[1]);
    if (!Number.isInteger(issueNumber) || issueNumber < 1) return notFound();
    const issue = store.getIssue(repo, issueNumber);
    if (rest.length === 2) {
      if (issue === undefined) return notFound();
      if (method === 'GET') return { status: 200, body: issueJson(issue) };
      if (method === 'PATCH') {
        const state = asString(body.state);
        if (state !== 'open' && state !== 'closed') return message(422, 'state must be "open" or "closed"');
        issue.state = state;
        return { status: 200, body: issueJson(issue) };
      }
      return notFound();
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (issue === undefined) return notFound();
      if (method === 'POST') {
        const comment = store.addIssueComment(repo, issue, asString(body.body));
        return { status: 201, body: { id: comment.id, body: comment.body } };
      }
      if (method === 'GET') {
        return { status: 200, body: issue.comments.map((comment) => ({ id: comment.id, body: comment.body })) };
      }
      return notFound();
    }
    return notFound();
  }

  // /pulls
  if (head === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') return createPull(store, repo, body);
      if (method === 'GET') return listPulls(store, repo, req, repoPath);
      return notFound();
    }
    const pullNumber = Number(rest[1]);
    if (!Number.isInteger(pullNumber) || pullNumber < 1) return notFound();
    const pull = store.getPullRequest(repo, pullNumber);
    if (rest.length === 2) {
      if (pull === undefined) return notFound();
      if (method === 'GET') return { status: 200, body: pullJson(pull) };
      return notFound();
    }
    if (rest.length === 3 && rest[2] === 'files') {
      if (pull === undefined) return notFound();
      if (method === 'GET') return { status: 200, body: pullFiles(repo, pull) };
      return notFound();
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      if (method === 'PUT') return mergePull(store, repo, pullNumber, body);
      return notFound();
    }
    return notFound();
  }

  return notFound();
}

// ---------------------------------------------------------------------------------------------
// repos
// ---------------------------------------------------------------------------------------------

function createRepo(store: Store, body: JsonObject): RestResult {
  const name = asString(body.name);
  if (name === '') return message(422, 'Repository name is required');
  if (store.hasRepo(VIEWER_LOGIN, name)) {
    return message(422, `${name} already exists`);
  }
  const repo = store.createRepo(VIEWER_LOGIN, name, {
    private: typeof body.private === 'boolean' ? body.private : false,
    description: asString(body.description),
  });
  return { status: 201, body: repoJson(repo) };
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function putContents(store: Store, repo: Repo, pathSegments: readonly string[], body: JsonObject): RestResult {
  const contentB64 = asString(body.content);
  if (contentB64 === '') return message(422, 'content is required');
  const bytes = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
  const branch = asString(body.branch) === '' ? repo.defaultBranch : asString(body.branch);
  const tip = branchTip(repo, branch);
  const currentTree = tip === undefined ? undefined : commitTree(repo, tip);
  const existing = lookupPath(repo, currentTree, pathSegments);
  const providedSha = asString(body.sha);
  if (providedSha !== '') {
    // An update must name the current blob sha; anything else is stale (409).
    if (existing === undefined || existing.mode === '40000' || existing.oid.toLowerCase() !== providedSha.toLowerCase()) {
      return message(409, 'sha does not match the current blob');
    }
  }
  const existedBefore = existing !== undefined && existing.mode !== '40000';
  const blobOid = store.putObject(repo, 'blob', bytes);
  const newTree = setPathInTree(store, repo, currentTree ?? null, pathSegments, blobOid);
  const commitOid = commitOnBranch(store, repo, branch, newTree, asString(body.message));
  return {
    status: existedBefore ? 200 : 201,
    body: {
      content: { name: pathSegments[pathSegments.length - 1], path: pathSegments.join('/'), sha: blobOid, size: bytes.length, encoding: 'base64' },
      commit: { sha: commitOid },
    },
  };
}

function getContents(repo: Repo, pathSegments: readonly string[], refParam: string | null): RestResult {
  let tip: string | undefined;
  if (refParam === null) {
    tip = branchTip(repo, repo.defaultBranch);
  } else {
    tip = resolveToCommitOid(repo, refParam);
    if (tip === undefined) return notFound('Not Found');
  }
  if (tip === undefined) return notFound('Not Found');
  const treeOid = commitTree(repo, tip);
  if (treeOid === undefined) return notFound('Not Found');
  const entry = lookupPath(repo, treeOid, pathSegments);
  if (entry === undefined) return notFound('Not Found');
  if (entry.mode === '40000') {
    const entries = treeEntries(repo, entry.oid).map((child) => ({
      type: child.mode === '40000' ? 'dir' : 'file',
      name: child.name,
      path: `${pathSegments.join('/')}/${child.name}`,
      sha: child.oid,
    }));
    return { status: 200, body: entries };
  }
  const object = repo.objects.get(entry.oid);
  if (object === undefined || object.type !== 'blob') return notFound('Not Found');
  return {
    status: 200,
    body: {
      type: 'file',
      name: pathSegments[pathSegments.length - 1],
      path: pathSegments.join('/'),
      encoding: 'base64',
      content: object.data.toString('base64'),
      sha: entry.oid,
      size: object.data.length,
    },
  };
}

function deleteContents(store: Store, repo: Repo, pathSegments: readonly string[], body: JsonObject): RestResult {
  const branch = asString(body.branch) === '' ? repo.defaultBranch : asString(body.branch);
  const tip = branchTip(repo, branch);
  if (tip === undefined) return notFound('Not Found');
  const currentTree = commitTree(repo, tip);
  if (currentTree === undefined) return notFound('Not Found');
  const existing = lookupPath(repo, currentTree, pathSegments);
  if (existing === undefined || existing.mode === '40000') return notFound('Not Found');
  const providedSha = asString(body.sha);
  if (providedSha !== '' && existing.oid.toLowerCase() !== providedSha.toLowerCase()) {
    return message(409, 'sha does not match the current blob');
  }
  const pruned = removePathFromTree(store, repo, currentTree, pathSegments);
  const newTree = pruned === null ? store.putObject(repo, 'tree', buildTree([])) : pruned;
  const commitOid = commitOnBranch(store, repo, branch, newTree, asString(body.message));
  return { status: 200, body: { commit: { sha: commitOid } } };
}

// ---------------------------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------------------------

function createIssue(store: Store, repo: Repo, body: JsonObject): RestResult {
  const labels = Array.isArray(body.labels) ? (body.labels as unknown[]) : [];
  for (const name of labels) {
    if (typeof name !== 'string' || store.getLabel(repo, name) === undefined) {
      return message(422, `Label '${String(name)}' does not exist in this repository`);
    }
  }
  const issue = store.createIssue(repo, asString(body.title), asString(body.body), {
    labels: labels as string[],
  });
  return { status: 201, body: issueJson(issue) };
}

function listIssues(store: Store, repo: Repo, req: RestRequest, repoPath: string): RestResult {
  const state = req.query.get('state') ?? 'open';
  let issues = store.listIssues(repo);
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  else if (state !== 'all') issues = issues.filter((issue) => issue.state === 'open');
  const sort = req.query.get('sort') ?? 'created';
  const direction = req.query.get('direction') ?? 'desc';
  if (sort === 'created') {
    issues = [...issues].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  }
  const path = `${repoPath}/issues`;
  const { pageItems, link } = paginate(
    issues.map((issue) => issueJson(issue)),
    req.query,
    req.origin,
    path,
  );
  return withLink({ status: 200, body: pageItems }, link);
}

// ---------------------------------------------------------------------------------------------
// pulls
// ---------------------------------------------------------------------------------------------

function createPull(store: Store, repo: Repo, body: JsonObject): RestResult {
  const headRef = asString(body.head);
  const baseRef = asString(body.base);
  const headSha = headRef === '' ? undefined : branchTip(repo, headRef);
  const baseSha = baseRef === '' ? undefined : branchTip(repo, baseRef);
  if (headSha === undefined || baseSha === undefined) {
    return message(422, 'head and base branches must exist');
  }
  const pull = store.createPullRequest(repo, asString(body.title), asString(body.body), { ref: headRef, sha: headSha }, { ref: baseRef, sha: baseSha });
  return { status: 201, body: pullJson(pull) };
}

function listPulls(store: Store, repo: Repo, req: RestRequest, repoPath: string): RestResult {
  const state = req.query.get('state');
  let pulls = store.listPullRequests(repo);
  if (state === 'all') {
    // no filter
  } else if (state === 'closed') {
    pulls = pulls.filter((pull) => pull.state === 'closed');
  } else {
    pulls = pulls.filter((pull) => pull.state === 'open');
  }
  const path = `${repoPath}/pulls`;
  const { pageItems, link } = paginate(
    pulls.map((pull) => pullJson(pull)),
    req.query,
    req.origin,
    path,
  );
  return withLink({ status: 200, body: pageItems }, link);
}

/** Changed files between the head tip tree and the base tip tree (direct diff). */
function pullFiles(repo: Repo, pull: import('./store.ts').PullRequest): JsonObject[] {
  const headTree = commitTree(repo, pull.head.sha);
  const baseTree = commitTree(repo, pull.base.sha);
  const headFiles = new Map<string, { oid: string; mode: string }>();
  const baseFiles = new Map<string, { oid: string; mode: string }>();
  flattenTree(repo, headTree, '', headFiles);
  flattenTree(repo, baseTree, '', baseFiles);
  const paths = new Set([...headFiles.keys(), ...baseFiles.keys()]);
  const out: JsonObject[] = [];
  for (const path of [...paths].sort()) {
    const headEntry = headFiles.get(path);
    const baseEntry = baseFiles.get(path);
    if (headEntry !== undefined && baseEntry !== undefined && headEntry.oid === baseEntry.oid) continue;
    const status = headEntry === undefined ? 'removed' : baseEntry === undefined ? 'added' : 'modified';
    const oldObject = baseEntry === undefined ? undefined : repo.objects.get(baseEntry.oid);
    const newObject = headEntry === undefined ? undefined : repo.objects.get(headEntry.oid);
    const counts = diffLineCounts(
      oldObject !== undefined && oldObject.type === 'blob' ? oldObject.data : undefined,
      newObject !== undefined && newObject.type === 'blob' ? newObject.data : undefined,
    );
    out.push({
      filename: path,
      status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    });
  }
  return out;
}

/** The best common ancestor of head and base tips, or null when they share none. */
function mergeBase(repo: Repo, headTip: string, baseTip: string): string | null {
  const headAncestors = ancestorSet(repo, headTip);
  const baseAncestors = ancestorSet(repo, baseTip);
  const common = [...headAncestors].filter((oid) => baseAncestors.has(oid));
  if (common.length === 0) return null;
  const ancestorCache = new Map<string, Set<string>>();
  const ancestorsOf = (oid: string): Set<string> => {
    let cached = ancestorCache.get(oid);
    if (cached === undefined) {
      cached = ancestorSet(repo, oid);
      ancestorCache.set(oid, cached);
    }
    return cached;
  };
  for (const candidate of common) {
    let dominated = false;
    for (const other of common) {
      if (other !== candidate && ancestorsOf(other).has(candidate)) {
        dominated = true;
        break;
      }
    }
    if (!dominated) return candidate;
  }
  return common[0] as string;
}

/** True when head and base both changed the same path (vs the merge-base) to different contents. */
function isConflicted(repo: Repo, pull: import('./store.ts').PullRequest): boolean {
  const baseTip = branchTip(repo, pull.base.ref);
  const headTip = branchTip(repo, pull.head.ref);
  if (baseTip === undefined || headTip === undefined) return false;
  const base = mergeBase(repo, headTip, baseTip);
  const baseTree = base === null ? undefined : commitTree(repo, base);
  const headTree = commitTree(repo, headTip);
  const newBaseTree = commitTree(repo, baseTip);
  const baseFiles = new Map<string, { oid: string; mode: string }>();
  const headFiles = new Map<string, { oid: string; mode: string }>();
  const newBaseFiles = new Map<string, { oid: string; mode: string }>();
  flattenTree(repo, baseTree, '', baseFiles);
  flattenTree(repo, headTree, '', headFiles);
  flattenTree(repo, newBaseTree, '', newBaseFiles);
  const changedOn = (side: Map<string, { oid: string; mode: string }>): Map<string, string | null> => {
    const changed = new Map<string, string | null>();
    const paths = new Set([...side.keys(), ...baseFiles.keys()]);
    for (const path of paths) {
      const sideEntry = side.get(path);
      const baseEntry = baseFiles.get(path);
      if (sideEntry === undefined && baseEntry === undefined) continue;
      if (sideEntry !== undefined && baseEntry !== undefined && sideEntry.oid === baseEntry.oid) continue;
      changed.set(path, sideEntry === undefined ? null : sideEntry.oid);
    }
    return changed;
  };
  const headChanged = changedOn(headFiles);
  const baseChanged = changedOn(newBaseFiles);
  for (const [path, headOid] of headChanged) {
    if (baseChanged.has(path) && baseChanged.get(path) !== headOid) return true;
  }
  return false;
}

function mergePull(store: Store, repo: Repo, pullNumber: number, _body: JsonObject): RestResult {
  const pull = store.getPullRequest(repo, pullNumber);
  if (pull === undefined) return notFound('Not Found');
  if (pull.merged) return message(405, 'Pull request is already merged');
  if (pull.state === 'closed') return message(405, 'Pull request is closed');
  if (isConflicted(repo, pull)) return message(405, 'Merge conflict');
  const baseTip = branchTip(repo, pull.base.ref);
  const headTip = branchTip(repo, pull.head.ref);
  if (baseTip === undefined || headTip === undefined) return notFound('Not Found');
  const headTree = commitTree(repo, headTip);
  if (headTree === undefined) return notFound('Not Found');
  // Squash: one commit on base whose tree is the head tip tree.
  const commitOid = store.putObject(
    repo,
    'commit',
    buildCommit({ tree: headTree, parents: [baseTip], message: pull.title, timestamp: TRIAL_NOW_SEC }),
  );
  repo.refs.set(`refs/heads/${pull.base.ref}`, commitOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = TRIAL_NOW_ISO;
  pull.mergeCommitSha = commitOid;
  return { status: 200, body: { merged: true, sha: commitOid, message: pull.title } };
}
