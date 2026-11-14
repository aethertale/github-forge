// lib/graphql.ts — GraphQL v4 executor for the fixed document subset the
// suite sends (PLAN §9; the 18 documents in checks-graphql.ts
// GRAPHQL_DOCUMENTS). Node stdlib only; no wall clock, no randomness, no fs.
// All timestamps from MAKEFUN_TRIAL_NOW (via util.ts); all mutations act on
// the shared store, so a GraphQL-created issue/PR reads back over REST with
// the same number and global id.
//
// Shape: a tokenizer + parser for the subset (query/mutation, operation
// names, variables, field aliases, arguments with variables/inline enums/
// inline input objects/null, inline fragments `... on T`, nested selections;
// no directives), then resolvers per type over the shared store. The
// envelope is always {data, errors}: a GraphQL-level failure is HTTP 200
// with an errors array; an unknown field reports an error whose message
// contains the literal `noSuchFieldOnViewer`; an unknown repository reads
// data.repository === null with no errors; a 2xx body always carries data
// or errors, never neither.

import type { Issue, PullRequest, Repo, Store } from './store.ts';
import { buildCommit, parseCommit, parseTag, parseTree, type TreeEntry } from './git-objects.ts';
import { TRIAL_NOW_ISO, TRIAL_NOW_SEC, VIEWER_LOGIN, deriveId } from './util.ts';

export interface GraphQLResult {
  readonly status: number;
  readonly body: unknown;
}

// ---------------------------------------------------------------------------------------------
// schema tables (field lists double as the introspection source and the
// unknown-field validator)
// ---------------------------------------------------------------------------------------------

const OBJECT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  PullRequest: [
    'id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'title', 'body',
  ],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFile: ['path'],
  User: ['login', 'id', 'name'],
  Ref: ['name'],
  Comment: ['id', 'body'],
  CommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
};

// ---------------------------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------------------------

type TokenKind = 'name' | 'string' | 'int' | 'punct' | 'spread';

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('$():{}[]!@='.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        const ch = input[i] as string;
        if (ch === '\\' && i + 1 < input.length) {
          const esc = input[i + 1] as string;
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'u' && i + 5 < input.length) {
            value += String.fromCharCode(Number.parseInt(input.slice(i + 2, i + 6), 16));
            i += 4;
          } else value += esc;
          i += 2;
          continue;
        }
        value += ch;
        i += 1;
      }
      i += 1; // closing quote
      tokens.push({ kind: 'string', value });
      continue;
    }
    if ((c >= '0' && c <= '9') || (c === '-' && i + 1 < input.length && (input[i + 1] as string) >= '0' && (input[i + 1] as string) <= '9')) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && ((input[j] as string) >= '0' && (input[j] as string) <= '9')) j += 1;
      tokens.push({ kind: 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_') {
      let j = i;
      while (
        j < input.length &&
        (((input[j] as string) >= 'A' && (input[j] as string) <= 'Z') ||
          ((input[j] as string) >= 'a' && (input[j] as string) <= 'z') ||
          ((input[j] as string) >= '0' && (input[j] as string) <= '9') ||
          input[j] === '_')
      ) {
        j += 1;
      }
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser (subset only; see the header)
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'list'; readonly items: readonly ValueNode[] }
  | { readonly kind: 'object'; readonly fields: Readonly<Record<string, ValueNode>> };

interface FieldNode {
  readonly kind: 'field';
  readonly name: string;
  readonly alias?: string;
  readonly args: Readonly<Record<string, ValueNode>>;
  readonly selections: readonly SelectionNode[];
}

interface FragmentNode {
  readonly kind: 'fragment';
  readonly typeCondition: string;
  readonly selections: readonly SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface Operation {
  readonly opType: 'query' | 'mutation';
  readonly name?: string;
  readonly varNames: readonly string[];
  readonly selections: readonly SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: readonly Token[];

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected "${value}" in GraphQL document, got ${token.value}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name in GraphQL document, got ${token.value}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected "${value}" in GraphQL document, got ${token.value}`);
    return token.value;
  }

  parseOperation(): Operation {
    let opType: 'query' | 'mutation' = 'query';
    let name: string | undefined;
    const first = this.peek();
    if (first !== undefined && first.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      opType = this.next().value as 'query' | 'mutation';
      const maybeName = this.peek();
      if (maybeName !== undefined && maybeName.kind === 'name') name = this.next().value;
    }
    const varNames: string[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        this.expectPunct('$');
        varNames.push(this.expectName());
        this.expectPunct(':');
        this.parseType();
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
          this.next();
          this.parseValue();
        }
      }
      this.expectPunct(')');
    }
    const selections = this.parseSelectionSet();
    return { opType, name, varNames, selections };
  }

  private parseType(): void {
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      if (this.peek() === undefined) throw new Error('unterminated selection set in GraphQL document');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token !== undefined && token.kind === 'spread') {
      this.next();
      this.expectName('on');
      const typeCondition = this.expectName();
      return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.expectPunct(')');
    }
    let selections: SelectionNode[] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const key = this.expectName();
        this.expectPunct(':');
        fields[key] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected token ${token.value} in GraphQL document`);
  }
}

/** Evaluate a parsed value against the operation's variables. */
function evalValue(node: ValueNode, variables: Readonly<Record<string, unknown>>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'enum':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = evalValue(value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// git helpers (same three-way analysis as REST lib/rest.ts, re-implemented
// locally — rest.ts does not export them)
// ---------------------------------------------------------------------------------------------

function resolveToCommitOid(repo: Repo, ref: string): string | undefined {
  const object = repo.objects.get(ref);
  if (object !== undefined) {
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

function branchTip(repo: Repo, branch: string): string | undefined {
  const oid = repo.refs.get(`refs/heads/${branch}`);
  if (oid === undefined) return undefined;
  return resolveToCommitOid(repo, oid);
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

function ancestorSet(repo: Repo, tip: string): Set<string> {
  return new Set(walkCommitList(repo, tip));
}

function mergeBase(repo: Repo, headTip: string, baseTip: string): string | null {
  const headAncestors = ancestorSet(repo, headTip);
  const baseAncestors = ancestorSet(repo, baseTip);
  const common = [...headAncestors].filter((oid) => baseAncestors.has(oid));
  if (common.length === 0) return null;
  const cache = new Map<string, Set<string>>();
  const ancestorsOf = (oid: string): Set<string> => {
    let cached = cache.get(oid);
    if (cached === undefined) {
      cached = ancestorSet(repo, oid);
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

/** Changed paths between two commit trees (head tip vs base tip), sorted. */
function changedPaths(repo: Repo, headSha: string, baseSha: string): string[] {
  const headTree = commitTree(repo, headSha);
  const baseTree = commitTree(repo, baseSha);
  const headFiles = new Map<string, string>();
  const baseFiles = new Map<string, string>();
  flattenTree(repo, headTree, '', headFiles);
  flattenTree(repo, baseTree, '', baseFiles);
  const paths = new Set([...headFiles.keys(), ...baseFiles.keys()]);
  const out: string[] = [];
  for (const path of paths) {
    if (headFiles.get(path) !== baseFiles.get(path)) out.push(path);
  }
  return out.sort();
}

/** Squash-merge a pull request, exactly as REST does: one commit on base
 * whose tree is the head tip tree, base ref moves, PR closed + merged. */
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
// node values + global-id lookups
// ---------------------------------------------------------------------------------------------

/** A resolved GraphQL object: its type plus the domain value (or a plain
 * record for structural types such as connections and payloads). */
interface NodeVal {
  readonly __typename: string;
  readonly __data: unknown;
}

function nodeVal(typename: string, data: unknown): NodeVal {
  return { __typename: typename, __data: data };
}

function repoNode(repo: Repo): NodeVal {
  return nodeVal('Repository', repo);
}

function issueNode(issue: Issue): NodeVal {
  return nodeVal('Issue', issue);
}

function prNode(pull: PullRequest): NodeVal {
  return nodeVal('PullRequest', pull);
}

function userNode(login: string): NodeVal {
  return nodeVal('User', { login });
}

function commentGqlId(repo: Repo, issue: Issue, commentId: number): string {
  return deriveId('C', `${repo.owner}/${repo.name}/issue/${issue.number}/comment/${commentId}`);
}

function findRepoById(store: Store, id: string): Repo | undefined {
  for (const repo of store.listRepos()) if (repo.id === id) return repo;
  return undefined;
}

function findIssueById(store: Store, id: string): { repo: Repo; issue: Issue } | undefined {
  for (const repo of store.listRepos()) {
    for (const issue of repo.issues.values()) {
      if (issue.id === id) return { repo, issue };
    }
  }
  return undefined;
}

function findPullById(store: Store, id: string): { repo: Repo; pull: PullRequest } | undefined {
  for (const repo of store.listRepos()) {
    for (const pull of repo.pulls.values()) {
      if (pull.id === id) return { repo, pull };
    }
  }
  return undefined;
}

/** Resolve a Relay global id to its node (repository, issue, pull request, or comment). */
function nodeById(store: Store, id: string): NodeVal | null {
  const repo = findRepoById(store, id);
  if (repo !== undefined) return repoNode(repo);
  const issue = findIssueById(store, id);
  if (issue !== undefined) return issueNode(issue.issue);
  const pull = findPullById(store, id);
  if (pull !== undefined) return prNode(pull.pull);
  for (const r of store.listRepos()) {
    for (const iss of r.issues.values()) {
      for (const comment of iss.comments) {
        if (commentGqlId(r, iss, comment.id) === id) {
          return nodeVal('Comment', { id, body: comment.body });
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// cursors (opaque, deterministic: base64 of "cursor:<last number seen>")
// ---------------------------------------------------------------------------------------------

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    if (match === null) return null;
    return Number.parseInt(match[1] as string, 10);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// resolvers
// ---------------------------------------------------------------------------------------------

interface GraphQLError {
  message: string;
  path?: (string | number)[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function prState(pull: PullRequest): string {
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issuesConnection(repo: Repo, args: Readonly<Record<string, unknown>>): NodeVal {
  let list = storeListIssues(repo);
  const orderBy = asRecord(args.orderBy);
  const desc = orderBy === null || asString(orderBy.direction) !== 'ASC';
  list = [...list].sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
  if (Array.isArray(args.states)) {
    const wanted = new Set(args.states.map((state) => String(state)));
    list = list.filter((issue) => wanted.has(issueState(issue)));
  }
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const last = decodeCursor(args.after);
    if (last !== null) {
      const index = list.findIndex((issue) => issue.number === last);
      if (index >= 0) start = index + 1;
    }
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(start, start + first);
  const hasNextPage = start + page.length < list.length;
  const endCursor = page.length === 0 ? null : encodeCursor((page[page.length - 1] as Issue).number);
  return nodeVal('IssueConnection', {
    nodes: page.map((issue) => issueNode(issue)),
    pageInfo: nodeVal('PageInfo', { hasNextPage, endCursor }),
    totalCount: list.length,
  });
}

function storeListIssues(repo: Repo): Issue[] {
  return [...repo.issues.values()].sort((a, b) => a.number - b.number);
}

function pullsConnection(repo: Repo, args: Readonly<Record<string, unknown>>): NodeVal {
  let list = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  return nodeVal('PullRequestConnection', {
    nodes: page.map((pull) => prNode(pull)),
    pageInfo: nodeVal('PageInfo', { hasNextPage: page.length < list.length, endCursor: null }),
    totalCount: list.length,
  });
}

function typeNode(name: string): NodeVal | null {
  const fields = OBJECT_FIELDS[name];
  const values = ENUM_VALUES[name];
  if (fields === undefined && values === undefined) return null;
  return nodeVal('__Type', { name, fields: fields ?? [], enumValues: values ?? [] });
}

/**
 * Resolve one field of `node`. Returns a scalar, a NodeVal, an array of
 * NodeVals, or null. Pushes an error and returns null for an unknown field
 * or a failed mutation input.
 */
function resolveField(
  store: Store,
  typeName: string,
  node: NodeVal,
  field: FieldNode,
  args: Readonly<Record<string, unknown>>,
  errors: GraphQLError[],
  path: readonly (string | number)[],
): unknown {
  const data = node.__data;
  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') return userNode(VIEWER_LOGIN);
      if (field.name === 'repository') {
        const repo = store.getRepo(asString(args.owner), asString(args.name));
        return repo === undefined ? null : repoNode(repo);
      }
      if (field.name === 'node') return nodeById(store, asString(args.id));
      if (field.name === '__type') return typeNode(asString(args.name));
      break;
    }
    case 'Mutation': {
      if (field.name === 'createIssue') return mutateCreateIssue(store, args, errors, path);
      if (field.name === 'closeIssue') return mutateCloseIssue(store, args, errors, path);
      if (field.name === 'createPullRequest') return mutateCreatePullRequest(store, args, errors, path);
      if (field.name === 'mergePullRequest') return mutateMergePullRequest(store, args, errors, path);
      if (field.name === 'addComment') return mutateAddComment(store, args, errors, path);
      break;
    }
    case 'Repository': {
      const repo = data as Repo;
      switch (field.name) {
        case 'id':
          return repo.id;
        case 'databaseId':
          return repo.databaseId;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return userNode(repo.owner);
        case 'defaultBranchRef':
          return nodeVal('Ref', { name: repo.defaultBranch });
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const issue = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
          return issue === undefined ? null : issueNode(issue);
        }
        case 'issues':
          return issuesConnection(repo, args);
        case 'pullRequests':
          return pullsConnection(repo, args);
        case 'pullRequest': {
          const pull = typeof args.number === 'number' ? repo.pulls.get(args.number) : undefined;
          return pull === undefined ? null : prNode(pull);
        }
      }
      break;
    }
    case 'Issue': {
      const issue = data as Issue;
      switch (field.name) {
        case 'id':
          return issue.id;
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issueState(issue);
        case 'body':
          return issue.body;
      }
      break;
    }
    case 'PullRequest': {
      const pull = data as PullRequest;
      switch (field.name) {
        case 'id':
          return pull.id;
        case 'number':
          return pull.number;
        case 'state':
          return prState(pull);
        case 'merged':
          return pull.merged;
        case 'headRefName':
          return pull.head.ref;
        case 'baseRefName':
          return pull.base.ref;
        case 'mergeable': {
          const repo = findRepoOfPull(store, pull);
          if (repo === undefined) return 'UNKNOWN';
          return isConflicted(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
        }
        case 'files': {
          const repo = findRepoOfPull(store, pull);
          if (repo === undefined) return nodeVal('PullRequestChangedFileConnection', { nodes: [], pageInfo: nodeVal('PageInfo', { hasNextPage: false, endCursor: null }) });
          const paths = changedPaths(repo, pull.head.sha, pull.base.sha);
          const first = typeof args.first === 'number' ? args.first : paths.length;
          const page = paths.slice(0, first);
          return nodeVal('PullRequestChangedFileConnection', {
            nodes: page.map((path) => nodeVal('PullRequestChangedFile', { path })),
            pageInfo: nodeVal('PageInfo', { hasNextPage: page.length < paths.length, endCursor: null }),
          });
        }
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
      }
      break;
    }
    case 'User': {
      const user = data as { login: string };
      if (field.name === 'login') return user.login;
      if (field.name === 'id') return user.login === VIEWER_LOGIN ? 1000 : 0;
      if (field.name === 'name') return user.login;
      break;
    }
    case 'Ref': {
      if (field.name === 'name') return (data as { name: string }).name;
      break;
    }
    case 'Comment': {
      const comment = data as { id: string; body: string };
      if (field.name === 'id') return comment.id;
      if (field.name === 'body') return comment.body;
      break;
    }
    case '__Type': {
      const type = data as { name: string; fields: readonly string[]; enumValues: readonly string[] };
      if (field.name === 'name') return type.name;
      if (field.name === 'kind') return type.enumValues.length > 0 && type.fields.length === 0 ? 'ENUM' : 'OBJECT';
      if (field.name === 'fields') return type.fields.map((name) => nodeVal('__Field', { name }));
      if (field.name === 'enumValues') return type.enumValues.map((name) => nodeVal('__EnumValue', { name }));
      if (field.name === 'description') return null;
      break;
    }
    case '__Field':
    case '__EnumValue': {
      if (field.name === 'name') return (data as { name: string }).name;
      if (field.name === 'description') return null;
      break;
    }
    default: {
      // Structural types (connections, payloads, edges, PageInfo): fields
      // live in the __data record.
      const record = asRecord(data);
      if (record !== null && field.name in record) return record[field.name] as unknown;
      break;
    }
  }
  // Unknown field on a known type.
  errors.push({
    message: `Cannot query field "${field.name}" on type "${typeName}": noSuchFieldOnViewer`,
    path: [...path, field.alias ?? field.name],
  });
  return null;
}

function findRepoOfPull(store: Store, pull: PullRequest): Repo | undefined {
  for (const repo of store.listRepos()) {
    if (repo.pulls.get(pull.number) === pull) return repo;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// mutations (same store as REST)
// ---------------------------------------------------------------------------------------------

function mutateCreateIssue(store: Store, args: Readonly<Record<string, unknown>>, errors: GraphQLError[], path: readonly (string | number)[]): unknown {
  const input = asRecord(args.input);
  if (input === null) {
    errors.push({ message: 'createIssue requires an input object', path: [...path, 'createIssue'] });
    return null;
  }
  const repo = findRepoById(store, asString(input.repositoryId));
  if (repo === undefined) {
    errors.push({ message: `createIssue: unknown repositoryId ${asString(input.repositoryId)}`, path: [...path, 'createIssue'] });
    return null;
  }
  const issue = store.createIssue(repo, asString(input.title), asString(input.body));
  return nodeVal('CreateIssuePayload', { issue: issueNode(issue), clientMutationId: null });
}

function mutateCloseIssue(store: Store, args: Readonly<Record<string, unknown>>, errors: GraphQLError[], path: readonly (string | number)[]): unknown {
  const input = asRecord(args.input);
  if (input === null) {
    errors.push({ message: 'closeIssue requires an input object', path: [...path, 'closeIssue'] });
    return null;
  }
  const found = findIssueById(store, asString(input.issueId));
  if (found === undefined) {
    errors.push({ message: `closeIssue: unknown issueId ${asString(input.issueId)}`, path: [...path, 'closeIssue'] });
    return null;
  }
  found.issue.state = 'closed';
  return nodeVal('CloseIssuePayload', { issue: issueNode(found.issue), clientMutationId: null });
}

function mutateCreatePullRequest(store: Store, args: Readonly<Record<string, unknown>>, errors: GraphQLError[], path: readonly (string | number)[]): unknown {
  const input = asRecord(args.input);
  if (input === null) {
    errors.push({ message: 'createPullRequest requires an input object', path: [...path, 'createPullRequest'] });
    return null;
  }
  const repo = findRepoById(store, asString(input.repositoryId));
  if (repo === undefined) {
    errors.push({ message: `createPullRequest: unknown repositoryId ${asString(input.repositoryId)}`, path: [...path, 'createPullRequest'] });
    return null;
  }
  const headRef = asString(input.headRefName);
  const baseRef = asString(input.baseRefName);
  const headSha = branchTip(repo, headRef);
  const baseSha = branchTip(repo, baseRef);
  if (headSha === undefined || baseSha === undefined) {
    errors.push({ message: 'createPullRequest: head and base branches must exist', path: [...path, 'createPullRequest'] });
    return null;
  }
  const pull = store.createPullRequest(repo, asString(input.title), '', { ref: headRef, sha: headSha }, { ref: baseRef, sha: baseSha });
  return nodeVal('CreatePullRequestPayload', { pullRequest: prNode(pull), clientMutationId: null });
}

function mutateMergePullRequest(store: Store, args: Readonly<Record<string, unknown>>, errors: GraphQLError[], path: readonly (string | number)[]): unknown {
  const input = asRecord(args.input);
  if (input === null) {
    errors.push({ message: 'mergePullRequest requires an input object', path: [...path, 'mergePullRequest'] });
    return null;
  }
  const found = findPullById(store, asString(input.pullRequestId));
  if (found === undefined) {
    errors.push({ message: `mergePullRequest: unknown pullRequestId ${asString(input.pullRequestId)}`, path: [...path, 'mergePullRequest'] });
    return null;
  }
  const { repo, pull } = found;
  if (pull.merged || pull.state === 'closed') {
    errors.push({ message: 'mergePullRequest: pull request is already merged or closed', path: [...path, 'mergePullRequest'] });
    return null;
  }
  if (isConflicted(repo, pull)) {
    errors.push({ message: 'mergePullRequest: merge conflict', path: [...path, 'mergePullRequest'] });
    return null;
  }
  if (squashMerge(store, repo, pull) === null) {
    errors.push({ message: 'mergePullRequest: could not resolve head or base branch', path: [...path, 'mergePullRequest'] });
    return null;
  }
  return nodeVal('MergePullRequestPayload', { pullRequest: prNode(pull), clientMutationId: null });
}

function mutateAddComment(store: Store, args: Readonly<Record<string, unknown>>, errors: GraphQLError[], path: readonly (string | number)[]): unknown {
  const input = asRecord(args.input);
  if (input === null) {
    errors.push({ message: 'addComment requires an input object', path: [...path, 'addComment'] });
    return null;
  }
  const found = findIssueById(store, asString(input.subjectId));
  if (found === undefined) {
    errors.push({ message: `addComment: unknown subjectId ${asString(input.subjectId)}`, path: [...path, 'addComment'] });
    return null;
  }
  const comment = store.addIssueComment(found.repo, found.issue, asString(input.body));
  const node = nodeVal('Comment', { id: commentGqlId(found.repo, found.issue, comment.id), body: comment.body });
  return nodeVal('AddCommentPayload', { commentEdge: nodeVal('CommentEdge', { node, cursor: null }), clientMutationId: null });
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

/** Is `value` a resolved GraphQL object node? */
function isNodeVal(value: unknown): value is NodeVal {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.__typename === 'string' && '__data' in record;
}

/** Apply a selection set to a resolved node value. */
function executeSelection(
  store: Store,
  typeName: string,
  node: NodeVal,
  selections: readonly SelectionNode[],
  variables: Readonly<Record<string, unknown>>,
  errors: GraphQLError[],
  path: readonly (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition === typeName) {
        Object.assign(out, executeSelection(store, typeName, node, selection.selections, variables, errors, path));
      }
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    const fieldPath = [...path, responseKey];
    if (selection.name === '__typename') {
      out[responseKey] = typeName;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(selection.args)) args[key] = evalValue(value, variables);
    const raw = resolveField(store, typeName, node, selection, args, errors, path);
    out[responseKey] = applySelections(store, raw, selection.selections, variables, errors, fieldPath);
  }
  return out;
}

/** Apply a field's sub-selections to its resolved value (scalar passthrough). */
function applySelections(
  store: Store,
  raw: unknown,
  selections: readonly SelectionNode[],
  variables: Readonly<Record<string, unknown>>,
  errors: GraphQLError[],
  path: readonly (string | number)[],
): unknown {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) {
    return raw.map((item, index) => applySelections(store, item, selections, variables, errors, [...path, index]));
  }
  if (isNodeVal(raw)) {
    if (selections.length === 0) return null;
    return executeSelection(store, raw.__typename, raw, selections, variables, errors, path);
  }
  return raw;
}

/** Execute one parsed operation against the store. Always returns an envelope with data or errors. */
function executeOperation(
  store: Store,
  operation: Operation,
  variables: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const errors: GraphQLError[] = [];
  const rootType = operation.opType === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(store, rootType, nodeVal(rootType, null), operation.selections, variables, errors, []);
  if (errors.length > 0) return { data, errors };
  return { data };
}

/** Execute one operation document ({query, variables, operationName?}). */
function executeDocument(store: Store, doc: unknown): Record<string, unknown> {
  const record = asRecord(doc);
  if (record === null) return { data: null, errors: [{ message: 'GraphQL operation must be a JSON object' }] };
  const query = record.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'GraphQL operation needs a query string' }] };
  }
  const variables = asRecord(record.variables) ?? {};
  let operation: Operation;
  try {
    const parser = new Parser(tokenize(query));
    operation = parser.parseOperation();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (typeof record.operationName === 'string' && record.operationName !== '' && operation.name !== undefined && operation.name !== record.operationName) {
    return { data: null, errors: [{ message: `operation ${record.operationName} not found in document` }] };
  }
  return executeOperation(store, operation, variables);
}

// ---------------------------------------------------------------------------------------------
// HTTP entry point (wired in app.ts: POST /api/graphql, after the auth gate)
// ---------------------------------------------------------------------------------------------

/**
 * Handle a POST /api/graphql body. A JSON object runs one operation and
 * answers one envelope; a JSON array runs one operation per element and
 * answers an array of envelopes in request order. GraphQL-level failures
 * are HTTP 200 with an errors array; only a malformed JSON body is HTTP 400.
 */
export function handleGraphQL(body: Buffer, store: Store): GraphQLResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, body: { message: 'Malformed JSON body' } };
  }
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map((doc) => executeDocument(store, doc)) };
  }
  return { status: 200, body: executeDocument(store, parsed) };
}
