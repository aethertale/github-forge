// lib/util.ts — deterministic helpers for the github-core-clone-01 forge.
//
// Rules (PLAN §5, §11, §13):
//   - No wall clock, no Math.random(), no random UUIDs anywhere in request code.
//   - Every timestamp comes from MAKEFUN_TRIAL_NOW, read ONCE at module load.
//   - Every id comes from a deterministic counter or from SHA-1 of stable inputs.
//   - Only Node stdlib: node:crypto (nothing else is needed here).

import { createHash } from 'node:crypto';

/** The all-zero object id: an unborn branch / absent object. */
export const ZERO_OID: string = '0'.repeat(40);

/** Viewer identity (PLAN §4, verified from the kit scenario). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
/** Full "Name <email>" identity string used in git author/committer lines. */
export const VIEWER_IDENT = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;

/** Default branch name for every repository. */
export const DEFAULT_BRANCH = 'main';

/**
 * The trial's fixed "now", in Unix seconds. Read once from MAKEFUN_TRIAL_NOW
 * at module load; later changes to process.env are deliberately ignored so a
 * request can never observe a different clock.
 *
 * Fallback (only when the variable is absent/invalid, e.g. local unit tests
 * run without it): 2025-01-01T00:00:00Z, the scenario epoch.
 */
function readTrialNowSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.trunc(n);
  }
  return 1735689600;
}

export const TRIAL_NOW_SEC: number = readTrialNowSec();

/** The trial's fixed "now", in Unix milliseconds. */
export const TRIAL_NOW_MS: number = TRIAL_NOW_SEC * 1000;

/** The trial's fixed "now" as an ISO-8601 string (UTC). */
export const TRIAL_NOW_ISO: string = new Date(TRIAL_NOW_MS).toISOString();

/** Current time for request handling: always the fixed trial time, never the wall clock. */
export function trialNowSec(): number {
  return TRIAL_NOW_SEC;
}

/** Current time for request handling, in milliseconds. */
export function trialNowMs(): number {
  return TRIAL_NOW_MS;
}

/** Format a git ident line value: `Name <email> <unixSec> +0000`. */
export function formatGitIdent(name: string, email: string, epochSec: number, timezone = '+0000'): string {
  return `${name} <${email}> ${Math.trunc(epochSec)} ${timezone}`;
}

/** Format the viewer ident with the trial timestamp: `ada iversen <...> <now> +0000`. */
export function viewerGitIdent(epochSec: number = TRIAL_NOW_SEC): string {
  return formatGitIdent(VIEWER_NAME, VIEWER_EMAIL, epochSec);
}

/** SHA-1 hex of the concatenation of `parts`, separated by NUL bytes. */
export function sha1Hex(...parts: ReadonlyArray<string | Buffer | Uint8Array>): string {
  const hash = createHash('sha1');
  for (let i = 0; i < parts.length; i += 1) {
    if (i > 0) hash.update('\0');
    hash.update(parts[i] as string);
  }
  return hash.digest('hex');
}

/**
 * Derive a stable opaque id: `<prefix>_<sha1 hex, first 32 chars>`.
 * The prefix guarantees the result is never a bare number, so e.g. a repo id
 * can never equal String(databaseId) and an issue id never String(number).
 */
export function deriveId(prefix: string, ...parts: ReadonlyArray<string | Buffer | Uint8Array>): string {
  return `${prefix}_${sha1Hex(...parts).slice(0, 32)}`;
}

/** True for a lowercase 40-hex object id. */
export function isObjectId(value: string): boolean {
  if (value.length !== 40) return false;
  for (let i = 0; i < 40; i += 1) {
    const c = value.charCodeAt(i);
    const digit = c >= 48 && c <= 57;
    const lowerHex = c >= 97 && c <= 102;
    if (!digit && !lowerHex) return false;
  }
  return true;
}

/**
 * A deterministic sequential counter. Counters are fine for determinism
 * because the suite drives requests in a fixed order; the counter value is a
 * pure function of how many prior requests ran.
 */
export class Counter {
  private nextValue: number;

  constructor(start = 1) {
    this.nextValue = start;
  }

  /** Return the next value and advance. First call returns `start`. */
  next(): number {
    const value = this.nextValue;
    this.nextValue += 1;
    return value;
  }

  /** The value the next call to next() will return, without advancing. */
  peek(): number {
    return this.nextValue;
  }
}

/** Create a sequential counter starting at `start` (default 1). */
export function createCounter(start = 1): Counter {
  return new Counter(start);
}
