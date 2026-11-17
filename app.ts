// app.ts — the forge's HTTP server: route dispatch, auth gate, JSON
// envelope. Implements PLAN §2/§3 (healthz, API root, meta) and §7 (git
// smart HTTP, via lib/git-http.ts). REST v3 (lib/rest.ts, Phase 3),
// GraphQL v4 (lib/graphql.ts, Phase 4) and MCP (lib/mcp.ts, Phase 5) plug
// into the dispatch below at the marked extension points; until then their
// paths answer the standard 404 JSON.
//
// Transport: the hand-rolled HTTP/1.1 server in lib/http-transport.ts
// (node:net), not node:http — the HTTP stack was ~175 us/request of
// server CPU against ~2 us of handler for a GET. The handler here is
// transport-agnostic: it takes a fully-buffered request and returns a
// fully-built response, so the transport can be swapped without touching
// routing. createApp still returns a Server with listen/address/close,
// so main.ts needs no change.
//
// Rules kept here: every JSON reply carries Content-Type
// `application/json; charset=utf-8`, an exact Content-Length, a body of
// JSON + "\n", and a non-empty X-GitHub-Request-Id (deterministic
// counter-based). Every route except /healthz requires
// `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`; missing or wrong -> 401
// JSON. Unknown routes -> 404 JSON, never HTML. No wall clock, no
// randomness, no filesystem access in request handling.

import type { Server } from 'node:net';
import { createTransportServer, type TransportRequest, type TransportResponse } from './lib/http-transport.ts';
import { createStore, type Store } from './lib/store.ts';
import { handleGitHttp, parseGitPath, type GitHttpRequest } from './lib/git-http.ts';
import { handleRest } from './lib/rest.ts';
import { handleGraphQL } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** The bearer token, read once at module load. Empty only in local tests without one. */
const SHOP_TOKEN: string = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/**
 * Parse the request URL once (the old code parsed it three times per
 * request: pathOf, then again in the git and REST branches). On a bad URL
 * returns a dummy for '/', which routes to the 404 exactly as before.
 */
function parseUrl(req: TransportRequest): URL {
  try {
    return new URL(req.url ?? '/', 'http://entry');
  } catch {
    return new URL('http://entry/');
  }
}

/** Split a pathname into decoded segments, skipping empties; `skip` leading segments are dropped. */
function pathSegments(pathname: string, skip: number): string[] {
  const segments: string[] = [];
  let start = 0;
  let seen = 0;
  for (let i = 0; i <= pathname.length; i += 1) {
    if (i === pathname.length || pathname[i] === '/') {
      if (i > start) {
        seen += 1;
        if (seen > skip) {
          const part = pathname.slice(start, i);
          segments.push(part.includes('%') ? decodeURIComponentSafe(part) : part);
        }
      }
      start = i + 1;
    }
  }
  return segments;
}

function decodeURIComponentSafe(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * Build the server. It binds nothing until the caller listens.
 *
 * @param store the shared store (single source of truth for git/REST/
 *   GraphQL/MCP). Defaults to a fresh empty store; tests pass a seeded one.
 */
export function createApp(store: Store = createStore()): Server {
  let requestCounter = 0;
  const nextRequestId = (): string => {
    requestCounter += 1;
    return `req-${requestCounter}`;
  };

  /** Answer one request with a JSON body; `headers` go beside the JSON ones. */
  function sendJson(status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): TransportResponse {
    const text = `${JSON.stringify(body)}\n`;
    const bodyBuffer = Buffer.from(text, 'utf8');
    return {
      status,
      headers: {
        'content-type': JSON_TYPE,
        'content-length': String(bodyBuffer.length),
        'X-GitHub-Request-Id': nextRequestId(),
        ...headers,
      },
      body: bodyBuffer,
    };
  }

  /** Answer one request with a pre-built (usually binary) body. */
  function sendRaw(status: number, headers: Readonly<Record<string, string>>, body: Buffer): TransportResponse {
    return {
      status,
      headers: { ...headers, 'content-length': String(body.length), 'X-GitHub-Request-Id': nextRequestId() },
      body,
    };
  }

  /** True when the request carries the shop token. Fail closed: with no
   * token configured, no bearer is ever accepted (Phase 3 fix). */
  function isAuthorized(req: TransportRequest): boolean {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return false;
    if (SHOP_TOKEN === '') return false;
    return header === `Bearer ${SHOP_TOKEN}`;
  }

  async function handle(req: TransportRequest): Promise<TransportResponse> {
    const url = parseUrl(req);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // The env's boot check calls this twice: 200 {"ok":true}. No auth.
    if (method === 'GET' && path === '/healthz') {
      return sendJson(200, { ok: true });
    }

    // Auth gate: everything else needs the bearer token.
    if (!isAuthorized(req)) {
      return sendJson(401, { message: 'Requires authentication' });
    }

    // Git smart HTTP: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}.
    const git = parseGitPath(path);
    if (git !== null) {
      const body = method === 'POST' ? req.body : Buffer.alloc(0);
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers[key] = value;
      }
      const gitRequest: GitHttpRequest = {
        method,
        kind: git.kind,
        owner: git.owner,
        repo: git.repo,
        query: url.searchParams,
        headers,
        body,
      };
      const result = handleGitHttp(gitRequest, store);
      return sendRaw(result.status, result.headers, result.body);
    }

    // The GitHub API root: a 200 with the token's scopes.
    if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
      return sendJson(
        200,
        { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
        { 'X-OAuth-Scopes': 'repo, read:org' },
      );
    }

    // Forge version probe.
    if (method === 'GET' && path === '/api/v3/meta') {
      return sendJson(200, { installed_version: '0.1.0' });
    }

    // REST v3 (lib/rest.ts): every other /api/v3/* route.
    if (path === '/api/v3/user' || path.startsWith('/api/v3/user/') || path.startsWith('/api/v3/repos/')) {
      const body = method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE' ? req.body : Buffer.alloc(0);
      const segments = pathSegments(url.pathname, 2);
      const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
      const result = handleRest({ method, segments, query: url.searchParams, body, origin }, store);
      if (result.status === 204) {
        return { status: 204, headers: { 'X-GitHub-Request-Id': nextRequestId(), 'content-length': '0' }, body: Buffer.alloc(0) };
      }
      return sendJson(result.status, result.body ?? {}, result.headers ?? {});
    }

    // GraphQL v4 (lib/graphql.ts): POST /api/graphql (auth gate above already 401s).
    if (method === 'POST' && path === '/api/graphql') {
      const result = handleGraphQL(req.body, store);
      return sendJson(result.status, result.body);
    }

    // MCP JSON-RPC 2.0 Streamable HTTP (lib/mcp.ts, Phase 5): POST /mcp.
    // DELETE /mcp closes a session best-effort -> 200, empty body.
    // Auth gate above already 401s unauthenticated calls.
    if (method === 'DELETE' && path === '/mcp') {
      return { status: 200, headers: { 'X-GitHub-Request-Id': nextRequestId(), 'content-length': '0' }, body: Buffer.alloc(0) };
    }
    if (method === 'POST' && path === '/mcp') {
      const result = handleMcp(req.body, store);
      if (result.text === null) {
        return { status: result.status, headers: { 'X-GitHub-Request-Id': nextRequestId(), 'content-length': '0' }, body: Buffer.alloc(0) };
      }
      return sendRaw(result.status, { 'content-type': JSON_TYPE }, Buffer.from(result.text, 'utf8'));
    }

    // Everything else, every method: GitHub's 404 body.
    return sendJson(404, { message: 'Not Found' });
  }

  return createTransportServer(async (req: TransportRequest): Promise<TransportResponse> => {
    try {
      return await handle(req);
    } catch {
      return sendJson(500, { message: 'Internal Server Error' });
    }
  });
}
