// lib/store.ts — in-memory store: the single source of truth shared by
// git/REST/GraphQL/MCP (PLAN §5, §11). No filesystem access, no wall clock,
// no randomness. Deterministic ids and counters only.
//
// Repos keyed by (owner, name). Per repo: refs Map, objects
// Map<oid, {type, data}>, issues, PRs, labels, comments.
// Counters: databaseId sequential from 1 (creation order), issue/PR numbers
// sequential from 1 per repo. Ids are opaque and stable: repo id is
// "R_" + sha1(owner/name), issue id "I_" + sha1(owner/name/issue/number),
// PR id "PR_" + sha1(owner/name/pr/number) — never a bare number, so an id
// never equals String(databaseId) or String(number).

import { Counter, DEFAULT_BRANCH, deriveId, sha1Hex } from './util.ts';
import type { GitObject, GitObjectType } from './git-objects.ts';
import { hashObject } from './git-objects.ts';

export interface Label {
  readonly name: string;
  color: string;
}

export interface IssueComment {
  readonly id: number;
  body: string;
}

export interface Issue {
  readonly number: number;
  readonly id: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  /** Global monotonic creation sequence, for CREATED_AT ordering. */
  readonly createdSeq: number;
  readonly comments: IssueComment[];
  /** Next comment id for this issue (per-issue sequential from 1). */
  nextCommentId: number;
}

export interface PullRequest {
  readonly number: number;
  readonly id: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  /** Global monotonic creation sequence, for ordering. */
  readonly createdSeq: number;
}

export interface Repo {
  readonly name: string;
  readonly owner: string;
  private: boolean;
  description: string;
  readonly defaultBranch: string;
  readonly databaseId: number;
  /** Opaque stable id, never String(databaseId). */
  readonly id: string;
  /** Creation sequence (repo listing order). */
  readonly createdSeq: number;
  /** ref name -> oid. HEAD is always refs/heads/<defaultBranch>. */
  readonly refs: Map<string, string>;
  /** oid -> object. Objects are per-repo: never leak across repos. */
  readonly objects: Map<string, GitObject>;
  readonly labels: Map<string, Label>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, PullRequest>;
  nextIssueNumber: number;
  nextPullNumber: number;
}

/** Owner/repo name rule (PLAN §7): start alnum, then alnum . _ -, max 100. */
export const OWNER_REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function isValidOwnerRepoName(value: string): boolean {
  return OWNER_REPO_NAME_RE.test(value);
}

/** Map key for a repo: owner and name separated by NUL (neither may contain it). */
export function repoKey(owner: string, name: string): string {
  return `${owner}\0${name}`;
}

export interface CreateRepoOptions {
  readonly private?: boolean;
  readonly description?: string;
}

export interface CreateIssueOptions {
  readonly labels?: readonly string[];
}

export class Store {
  private readonly repos = new Map<string, Repo>();
  private readonly databaseIdCounter = new Counter(1);
  private readonly createdSeqCounter = new Counter(1);

  /** Next global creation sequence value (monotonic, deterministic). */
  nextCreatedSeq(): number {
    return this.createdSeqCounter.next();
  }

  // -- repos -----------------------------------------------------------------

  createRepo(owner: string, name: string, options: CreateRepoOptions = {}): Repo {
    const key = repoKey(owner, name);
    const existing = this.repos.get(key);
    if (existing !== undefined) return existing;
    const databaseId = this.databaseIdCounter.next();
    const repo: Repo = {
      name,
      owner,
      private: options.private ?? false,
      description: options.description ?? '',
      defaultBranch: DEFAULT_BRANCH,
      databaseId,
      id: deriveId('R', `${owner}/${name}`),
      createdSeq: this.createdSeqCounter.next(),
      refs: new Map<string, string>(),
      objects: new Map<string, GitObject>(),
      labels: new Map<string, Label>(),
      issues: new Map<number, Issue>(),
      pulls: new Map<number, PullRequest>(),
      nextIssueNumber: 1,
      nextPullNumber: 1,
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  hasRepo(owner: string, name: string): boolean {
    return this.repos.has(repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(repoKey(owner, name));
  }

  /** All repos, in creation order. */
  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  /** Repos owned by `owner`, in creation order. */
  listReposByOwner(owner: string): Repo[] {
    return this.listRepos().filter((repo) => repo.owner === owner);
  }

  get repoCount(): number {
    return this.repos.size;
  }

  // -- git objects -----------------------------------------------------------

  /** Store an object, returning its SHA-1 oid. No copy: the buffer is kept by reference. */
  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  // -- refs ------------------------------------------------------------------

  /** HEAD target for a repo: always refs/heads/<defaultBranch>. */
  headRef(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  getRef(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
  }

  deleteRef(repo: Repo, ref: string): boolean {
    return repo.refs.delete(ref);
  }

  /** Branch names (refs/heads/*, bare), sorted. */
  listBranches(repo: Repo): string[] {
    const names: string[] = [];
    for (const ref of repo.refs.keys()) {
      if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
    }
    return names.sort();
  }

  // -- labels ----------------------------------------------------------------

  createLabel(repo: Repo, name: string, color: string): Label {
    const existing = repo.labels.get(name);
    if (existing !== undefined) {
      existing.color = color;
      return existing;
    }
    const label: Label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  getLabel(repo: Repo, name: string): Label | undefined {
    return repo.labels.get(name);
  }

  // -- issues ----------------------------------------------------------------

  createIssue(
    repo: Repo,
    title: string,
    body: string,
    options: CreateIssueOptions = {},
  ): Issue {
    const number = repo.nextIssueNumber;
    repo.nextIssueNumber += 1;
    const labels: Label[] = [];
    for (const name of options.labels ?? []) {
      const label = repo.labels.get(name);
      if (label !== undefined) labels.push(label);
    }
    const issue: Issue = {
      number,
      id: deriveId('I', `${repo.owner}/${repo.name}/issue/${number}`),
      title,
      body,
      state: 'open',
      labels,
      createdSeq: this.createdSeqCounter.next(),
      comments: [],
      nextCommentId: 1,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.get(number);
  }

  /** Issues in creation order (number ascending). */
  listIssues(repo: Repo): Issue[] {
    return [...repo.issues.values()].sort((a, b) => a.number - b.number);
  }

  addIssueComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const comment: IssueComment = { id: issue.nextCommentId, body };
    issue.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  // -- pull requests ---------------------------------------------------------

  createPullRequest(
    repo: Repo,
    title: string,
    body: string,
    head: { ref: string; sha: string },
    base: { ref: string; sha: string },
  ): PullRequest {
    const number = repo.nextPullNumber;
    repo.nextPullNumber += 1;
    const pr: PullRequest = {
      number,
      id: deriveId('PR', `${repo.owner}/${repo.name}/pr/${number}`),
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head: { ...head },
      base: { ...base },
      createdSeq: this.createdSeqCounter.next(),
    };
    repo.pulls.set(number, pr);
    return pr;
  }

  getPullRequest(repo: Repo, number: number): PullRequest | undefined {
    return repo.pulls.get(number);
  }

  /** Pull requests in creation order (number ascending). */
  listPullRequests(repo: Repo): PullRequest[] {
    return [...repo.pulls.values()].sort((a, b) => a.number - b.number);
  }
}

/** Create an empty store. */
export function createStore(): Store {
  return new Store();
}

/** Convenience re-export: SHA-1 of stable inputs, for id derivation in later phases. */
export { sha1Hex };
