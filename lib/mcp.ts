// lib/mcp.ts — MCP JSON-RPC 2.0 Streamable HTTP (PLAN §10). One endpoint,
// POST /mcp, plain-JSON answers (the client accepts JSON or SSE; JSON is
// simplest). All tools act on the shared store, so a repo/issue/PR created
// here reads back identically over REST/GraphQL/git. Node stdlib only; no
// wall clock, no randomness, no filesystem access in request handling.
//
// Protocol eras supported:
//   modern 2026-07-28: server/discover, no handshake, no session.
//   legacy: initialize (echo the offered YYYY-MM-DD revision, else
//     2025-11-25) + notifications/initialized (HTTP 202, empty body).
// Unknown methods -> JSON-RPC -32601, HTTP 200. Malformed JSON body ->
// HTTP 400 + -32700. Never HTTP 500 for a JSON-RPC error.

import type { Issue, PullRequest, Repo, Store } from './store.ts';
import { VIEWER_LOGIN } from './util.ts';
import { TRIAL_NOW_ISO, TRIAL_NOW_SEC } from './util.ts';
import { buildCommit, parseCommit, parseTree, type TreeEntry } from './git-objects.ts';

export interface McpResult {
  readonly status: number;
  /** Exact response body, or null for an empty body (202 notification / DELETE). */
  readonly text: string | null;
}

const SERVER_NAME = 'github-forge';
const SERVER_VERSION = '0.1.0';
const MODERN_REVISION = '2026-07-28';
const LEGACY_FALLBACK_REVISION = '2025-11-25';
const REVISION_RE = /^\d{4}-\d{2}-\d{2}$/;

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** JSON-RPC success envelope, serialized once. `idJson` is the raw JSON of the request id. */
function successText(idJson: string, resultJson: string): string {
  return `{"jsonrpc":"2.0","id":${idJson},"result":${resultJson}}`;
}

/** JSON-RPC error envelope, serialized once. Always HTTP 200 (except parse errors, HTTP 400). */
function errorText(idJson: string, code: number, message: string): string {
  return `{"jsonrpc":"2.0","id":${idJson},"error":{"code":${code},"message":${JSON.stringify(message)}}}`;
}

// ---------------------------------------------------------------------------------------------
// tools/list — built once at startup; the same cached string every call,
// so two tools/list answers are byte-identical.
// ---------------------------------------------------------------------------------------------

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly properties: JsonObject;
  readonly required: string[];
}

const TOOL_DEFS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the given owner (defaults to the viewer).',
    properties: {
      name: { type: 'string', description: 'Repository name.' },
      description: { type: 'string', description: 'Repository description.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
      owner: { type: 'string', description: 'Owner login of the repository.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'Owner login of the repository.' },
      repo: { type: 'string', description: 'Repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'Owner login of the repository.' },
      repo: { type: 'string', description: 'Repository name.' },
      title: { type: 'string', description: 'Issue title.' },
      body: { type: 'string', description: 'Issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'Owner login of the repository.' },
      repo: { type: 'string', description: 'Repository name.' },
      state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'Owner login of the repository.' },
      repo: { type: 'string', description: 'Repository name.' },
      title: { type: 'string', description: 'Pull request title.' },
      head: { type: 'string', description: 'Head branch name.' },
      base: { type: 'string', description: 'Base branch name.' },
      body: { type: 'string', description: 'Pull request body.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    properties: {
      owner: { type: 'string', description: 'Owner login of the repository.' },
      repo: { type: 'string', description: 'Repository name.' },
      pull_number: { type: 'integer', description: 'Pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

/** The tools array, serialized once at startup. Key order is fixed by construction. */
const TOOLS_JSON: string = JSON.stringify(
  TOOL_DEFS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  })),
);

// ---------------------------------------------------------------------------------------------
// tool name matching (PLAN §10): normalized exact match, then suffix match.
// ---------------------------------------------------------------------------------------------

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const TOOL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  create_repo: ['create_repository', 'repo_create', 'repos_create', 'repository_create'],
  get_repo: ['get_repository', 'repo_get', 'repos_get', 'repository_get'],
  create_issue: ['issue_create', 'issues_create'],
  list_issues: ['issues_list', 'issue_list'],
  create_pull_request: ['pull_request_create', 'pulls_create', 'create_pr', 'pr_create'],
  merge_pull_request: ['pull_request_merge', 'pulls_merge', 'merge_pr', 'pr_merge'],
};

/** The canonical tool a (possibly prefixed/aliased) name serves, or null. */
function canonicalTool(name: string): string | null {
  const wanted = normalizeName(name);
  if (wanted === '') return null;
  for (const def of TOOL_DEFS) {
    const candidates = [def.name, ...(TOOL_ALIASES[def.name] ?? [])].map(normalizeName);
    if (candidates.includes(wanted)) return def.name;
  }
  for (const def of TOOL_DEFS) {
    const candidates = [def.name, ...(TOOL_ALIASES[def.name] ?? [])].map(normalizeName);
    for (const candidate of candidates) {
      if (wanted.length > candidate.length && wanted.endsWith(candidate)) return def.name;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// argument mapping: canonical names first, common synonyms as fallback.
// ---------------------------------------------------------------------------------------------

/** First non-empty string among `keys` in `args` (canonical key first). */
function pickString(args: JsonObject, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/** First integer among `keys` in `args` (numeric strings coerce). */
function pickInt(args: JsonObject, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

/** Owner + repo out of the arguments, splitting a full_name when needed. */
function resolveOwnerRepo(args: JsonObject): { owner?: string; repo?: string } {
  let owner = pickString(args, ['owner', 'owner_login', 'org', 'organization', 'organisation', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name']);
  let repo = pickString(args, ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name']);
  if ((owner === undefined || repo === undefined)) {
    const fullName = pickString(args, ['full_name', 'repo_full_name', 'repository_full_name', 'fullName']);
    if (fullName !== undefined) {
      const slash = fullName.indexOf('/');
      if (slash > 0 && slash < fullName.length - 1) {
        owner ??= fullName.slice(0, slash);
        repo ??= fullName.slice(slash + 1);
      }
    }
  }
  return { owner, repo };
}

// ---------------------------------------------------------------------------------------------
// shapes (same store objects REST returns, same ids)
// ---------------------------------------------------------------------------------------------

function repoResult(repo: Repo): JsonObject {
  return {
    id: repo.id,
    databaseId: repo.databaseId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: repo.owner,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueResult(issue: Issue): JsonObject {
  return {
    number: issue.number,
    id: issue.id,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name })),
  };
}

function pullResult(pull: PullRequest): JsonObject {
  return {
    number: pull.number,
    id: pull.id,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: { ref: pull.head.ref, sha: pull.head.sha },
    base: { ref: pull.base.ref, sha: pull.base.sha },
  };
}

/** A tool result carrying both readers: text (JSON string) and structuredContent. */
function toolResult(result: unknown): string {
  const text = JSON.stringify(result);
  return JSON.stringify({ content: [{ type: 'text', text }], structuredContent: result });
}

/** A tool execution failure: isError true, no JSON-RPC error. */
function toolError(message: string): string {
  return JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true });
}

// ---------------------------------------------------------------------------------------------
// git helpers for squash merge (same rules as REST/GraphQL: one commit on
// base whose tree is the head tip tree; conflicted -> refuse).
// ---------------------------------------------------------------------------------------------

function branchTip(repo: Repo, branch: string): string | undefined {
  const oid = repo.refs.get(`refs/heads/${branch}`);
  if (oid === undefined) return undefined;
  const object = repo.objects.get(oid);
  return object !== undefined && object.type === 'commit' ? oid : undefined;
}

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

function flattenTree(repo: Repo, treeOid: string | undefined, prefix: string, out: Map<string, string>): void {
  for (const entry of treeEntries(repo, treeOid)) {
    if (entry.mode === '160000') continue;
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, entry.oid);
  }
}

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

function mergeBase(repo: Repo, headTip: string, baseTip: string): string | null {
  const headAncestors = new Set(walkCommitList(repo, headTip));
  const baseAncestors = new Set(walkCommitList(repo, baseTip));
  const common = [...headAncestors].filter((oid) => baseAncestors.has(oid));
  if (common.length === 0) return null;
  const cache = new Map<string, Set<string>>();
  const ancestorsOf = (oid: string): Set<string> => {
    let cached = cache.get(oid);
    if (cached === undefined) {
      cached = new Set(walkCommitList(repo, oid));
      cache.set(oid, cached);
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
function isConflicted(repo: Repo, pull: PullRequest): boolean {
  const baseTip = branchTip(repo, pull.base.ref);
  const headTip = branchTip(repo, pull.head.ref);
  if (baseTip === undefined || headTip === undefined) return false;
  const base = mergeBase(repo, headTip, baseTip);
  const baseTree = base === null ? undefined : commitTree(repo, base);
  const headTree = commitTree(repo, headTip);
  const newBaseTree = commitTree(repo, baseTip);
  const baseFiles = new Map<string, string>();
  const headFiles = new Map<string, string>();
  const newBaseFiles = new Map<string, string>();
  flattenTree(repo, baseTree, '', baseFiles);
  flattenTree(repo, headTree, '', headFiles);
  flattenTree(repo, newBaseTree, '', newBaseFiles);
  const changedOn = (side: Map<string, string>): Map<string, string | null> => {
    const changed = new Map<string, string | null>();
    const paths = new Set([...side.keys(), ...baseFiles.keys()]);
    for (const path of paths) {
      const sideEntry = side.get(path);
      const baseEntry = baseFiles.get(path);
      if (sideEntry === undefined && baseEntry === undefined) continue;
      if (sideEntry !== undefined && baseEntry !== undefined && sideEntry === baseEntry) continue;
      changed.set(path, sideEntry === undefined ? null : sideEntry);
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

/** Squash-merge, exactly as REST does. Returns the merge commit oid, or null when a tip is unresolvable. */
function squashMerge(store: Store, repo: Repo, pull: PullRequest): string | null {
  const baseTip = branchTip(repo, pull.base.ref);
  const headTip = branchTip(repo, pull.head.ref);
  if (baseTip === undefined || headTip === undefined) return null;
  const headTree = commitTree(repo, headTip);
  if (headTree === undefined) return null;
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
  return commitOid;
}

// ---------------------------------------------------------------------------------------------
// tools/call dispatch. Returns the JSON-RPC result JSON string, or an error
// {code, message} to answer as a JSON-RPC error.
// ---------------------------------------------------------------------------------------------

type ToolOutcome = { result: string } | { error: { code: number; message: string } };

function callTool(store: Store, name: string, args: JsonObject): ToolOutcome {
  const canonical = canonicalTool(name);
  if (canonical === null) {
    return { error: { code: -32601, message: `Unknown tool: ${name}` } };
  }

  // Required-argument validation, before acting. Missing -> -32602 naming the argument.
  const requireArgs = (missing: string[]): ToolOutcome | null => {
    if (missing.length === 0) return null;
    return { error: { code: -32602, message: `Missing required argument(s): ${missing.join(', ')}` } };
  };

  switch (canonical) {
    case 'create_repo': {
      const repoName = pickString(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name']);
      const missing = repoName === undefined ? ['name'] : [];
      const bad = requireArgs(missing);
      if (bad !== null) return bad;
      const owner = pickString(args, ['owner', 'owner_login', 'org', 'organization', 'organisation', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name']) ?? VIEWER_LOGIN;
      const description = pickString(args, ['description', 'about', 'summary', 'body']) ?? '';
      const isPrivate = asBool(args.private) ?? asBool(args.is_private) ?? false;
      const repo = store.createRepo(owner, repoName as string, { private: isPrivate, description });
      return { result: toolResult(repoResult(repo)) };
    }

    case 'get_repo': {
      const { owner, repo: repoName } = resolveOwnerRepo(args);
      const missing: string[] = [];
      if (owner === undefined) missing.push('owner');
      if (repoName === undefined) missing.push('repo');
      const bad = requireArgs(missing);
      if (bad !== null) return bad;
      const repo = store.getRepo(owner as string, repoName as string);
      if (repo === undefined) return { result: toolError(`Repository not found: ${owner}/${repoName}`) };
      return { result: toolResult(repoResult(repo)) };
    }

    case 'create_issue': {
      const { owner, repo: repoName } = resolveOwnerRepo(args);
      const title = pickString(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject']);
      const missing: string[] = [];
      if (owner === undefined) missing.push('owner');
      if (repoName === undefined) missing.push('repo');
      if (title === undefined) missing.push('title');
      const bad = requireArgs(missing);
      if (bad !== null) return bad;
      const repo = store.getRepo(owner as string, repoName as string);
      if (repo === undefined) return { result: toolError(`Repository not found: ${owner}/${repoName}`) };
      const body = pickString(args, ['body', 'issue_body', 'description', 'content', 'text', 'comment']) ?? '';
      const issue = store.createIssue(repo, title as string, body);
      return { result: toolResult(issueResult(issue)) };
    }

    case 'list_issues': {
      const { owner, repo: repoName } = resolveOwnerRepo(args);
      const missing: string[] = [];
      if (owner === undefined) missing.push('owner');
      if (repoName === undefined) missing.push('repo');
      const bad = requireArgs(missing);
      if (bad !== null) return bad;
      const repo = store.getRepo(owner as string, repoName as string);
      if (repo === undefined) return { result: toolError(`Repository not found: ${owner}/${repoName}`) };
      const state = pickString(args, ['state', 'status']);
      let issues = store.listIssues(repo);
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      return { result: toolResult(issues.map((issue) => issueResult(issue))) };
    }

    case 'create_pull_request': {
      const { owner, repo: repoName } = resolveOwnerRepo(args);
      const title = pickString(args, ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject']);
      const head = pickString(args, ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch']);
      const base = pickString(args, ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch']);
      const missing: string[] = [];
      if (owner === undefined) missing.push('owner');
      if (repoName === undefined) missing.push('repo');
      if (title === undefined) missing.push('title');
      if (head === undefined) missing.push('head');
      if (base === undefined) missing.push('base');
      const bad = requireArgs(missing);
      if (bad !== null) return bad;
      const repo = store.getRepo(owner as string, repoName as string);
      if (repo === undefined) return { result: toolError(`Repository not found: ${owner}/${repoName}`) };
      const headSha = branchTip(repo, head as string);
      const baseSha = branchTip(repo, base as string);
      if (headSha === undefined || baseSha === undefined) {
        return { result: toolError(`head and base branches must exist: ${head} -> ${base}`) };
      }
      const body = pickString(args, ['body', 'issue_body', 'description', 'content', 'text', 'comment']) ?? '';
      const pull = store.createPullRequest(repo, title as string, body, { ref: head as string, sha: headSha }, { ref: base as string, sha: baseSha });
      return { result: toolResult(pullResult(pull)) };
    }

    case 'merge_pull_request': {
      const { owner, repo: repoName } = resolveOwnerRepo(args);
      const pullNumber = pickInt(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index']);
      const missing: string[] = [];
      if (owner === undefined) missing.push('owner');
      if (repoName === undefined) missing.push('repo');
      if (pullNumber === undefined) missing.push('pull_number');
      const bad = requireArgs(missing);
      if (bad !== null) return bad;
      const repo = store.getRepo(owner as string, repoName as string);
      if (repo === undefined) return { result: toolError(`Repository not found: ${owner}/${repoName}`) };
      const pull = store.getPullRequest(repo, pullNumber as number);
      if (pull === undefined) return { result: toolError(`Pull request not found: #${pullNumber}`) };
      if (pull.merged) {
        return { result: toolResult({ merged: true, number: pull.number, sha: pull.mergeCommitSha, message: pull.title }) };
      }
      if (pull.state === 'closed') return { result: toolError('Pull request is closed') };
      if (isConflicted(repo, pull)) return { result: toolError('Merge conflict') };
      const sha = squashMerge(store, repo, pull);
      if (sha === null) return { result: toolError('Could not resolve head or base branch') };
      return { result: toolResult({ merged: true, number: pull.number, sha, message: pull.title }) };
    }

    default:
      return { error: { code: -32601, message: `Unknown tool: ${name}` } };
  }
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------------------------

/**
 * Handle one POST /mcp body. Returns the HTTP status and the exact response
 * body, or null text for a notification (HTTP 202, empty body).
 */
export function handleMcp(body: Buffer, store: Store): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return {
      status: 400,
      text: `{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}`,
    };
  }
  if (!isRecord(parsed)) {
    return { status: 200, text: errorText('null', -32600, 'Invalid Request') };
  }
  const method = asString(parsed.method);
  if (method === '') {
    return { status: 200, text: errorText('null', -32600, 'Invalid Request') };
  }
  const hasId = parsed.id !== undefined && parsed.id !== null;
  const idJson = hasId ? JSON.stringify(parsed.id) : 'null';
  // Notifications (no id) get no JSON-RPC response: HTTP 202, empty body.
  if (!hasId) return { status: 202, text: null };
  const params = isRecord(parsed.params) ? parsed.params : {};
  // params._meta is transport metadata; it never leaks into tool arguments.

  switch (method) {
    case 'server/discover': {
      const result = JSON.stringify({
        supportedVersions: [MODERN_REVISION],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      });
      return { status: 200, text: successText(idJson, result) };
    }

    case 'initialize': {
      const offered = asString(params.protocolVersion);
      const negotiated = REVISION_RE.test(offered) ? offered : LEGACY_FALLBACK_REVISION;
      const result = JSON.stringify({
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return { status: 200, text: successText(idJson, result) };
    }

    case 'tools/list': {
      // Single page, no nextCursor; the tools JSON is cached at startup.
      return { status: 200, text: successText(idJson, `{"tools":${TOOLS_JSON}}`) };
    }

    case 'tools/call': {
      const name = asString(params.name);
      const args = isRecord(params.arguments) ? params.arguments : {};
      if (name === '') {
        return { status: 200, text: errorText(idJson, -32602, 'Missing required argument: name') };
      }
      const outcome = callTool(store, name, args);
      if ('error' in outcome) {
        return { status: 200, text: errorText(idJson, outcome.error.code, outcome.error.message) };
      }
      return { status: 200, text: successText(idJson, outcome.result) };
    }

    default:
      return { status: 200, text: errorText(idJson, -32601, `Method not found: ${method}`) };
  }
}
