// app.ts — the forge's HTTP server: route dispatch, auth gate, JSON
// envelope. Implements PLAN §2/§3 (healthz, API root, meta) and §7 (git
// smart HTTP, via lib/git-http.ts). REST v3 (lib/rest.ts, Phase 3),
// GraphQL v4 (lib/graphql.ts, Phase 4) and MCP (lib/mcp.ts, Phase 5) plug
// into the dispatch below at the marked extension points; until then their
// paths answer the standard 404 JSON.
//
// Rules kept here: every JSON reply carries Content-Type
// `application/json; charset=utf-8`, an exact Content-Length, a body of
// JSON + "\n", and a non-empty X-GitHub-Request-Id (deterministic
// counter-based). Every route except /healthz requires
// `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`; missing or wrong -> 401
// JSON. Unknown routes -> 404 JSON, never HTML. No wall clock, no
// randomness, no filesystem access in request handling.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createStore, type Store } from './lib/store.ts';
import { handleGitHttp, parseGitPath, type GitHttpRequest } from './lib/git-http.ts';
import { handleRest } from './lib/rest.ts';
import { handleGraphQL } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** The bearer token, read once at module load. Empty only in local tests without one. */
const SHOP_TOKEN: string = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** Read a request body fully. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
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
  function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
    const text = `${JSON.stringify(body)}\n`;
    res.writeHead(status, {
      'content-type': JSON_TYPE,
      'content-length': Buffer.byteLength(text),
      'X-GitHub-Request-Id': nextRequestId(),
      ...headers,
    });
    res.end(text);
  }

  /** Answer one request with a pre-built (usually binary) body. */
  function sendRaw(res: ServerResponse, status: number, headers: Readonly<Record<string, string>>, body: Buffer): void {
    res.writeHead(status, { ...headers, 'content-length': body.length, 'X-GitHub-Request-Id': nextRequestId() });
    res.end(body);
  }

  /** True when the request carries the shop token. Fail closed: with no
   * token configured, no bearer is ever accepted (Phase 3 fix). */
  function isAuthorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return false;
    if (SHOP_TOKEN === '') return false;
    return header === `Bearer ${SHOP_TOKEN}`;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    // The env's boot check calls this twice: 200 {"ok":true}. No auth.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Auth gate: everything else needs the bearer token.
    if (!isAuthorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}.
    const git = parseGitPath(path);
    if (git !== null) {
      const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers[key] = value;
      }
      const url = new URL(req.url ?? '/', 'http://entry');
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
      sendRaw(res, result.status, result.headers, result.body);
      return;
    }

    // The GitHub API root: a 200 with the token's scopes.
    if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
      sendJson(
        res,
        200,
        { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
        { 'X-OAuth-Scopes': 'repo, read:org' },
      );
      return;
    }

    // Forge version probe.
    if (method === 'GET' && path === '/api/v3/meta') {
      sendJson(res, 200, { installed_version: '0.1.0' });
      return;
    }

    // REST v3 (lib/rest.ts): every other /api/v3/* route.
    if (path === '/api/v3/user' || path.startsWith('/api/v3/user/') || path.startsWith('/api/v3/repos/')) {
      const body = method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE' ? await readBody(req) : Buffer.alloc(0);
      const url = new URL(req.url ?? '/', 'http://entry');
      const segments = url.pathname
        .split('/')
        .filter((part) => part !== '')
        .slice(2)
        .map((part) => {
          try {
            return decodeURIComponent(part);
          } catch {
            return part;
          }
        });
      const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
      const result = handleRest({ method, segments, query: url.searchParams, body, origin }, store);
      if (result.status === 204) {
        res.writeHead(204, { 'X-GitHub-Request-Id': nextRequestId(), 'content-length': '0' });
        res.end();
        return;
      }
      sendJson(res, result.status, result.body ?? {}, result.headers ?? {});
      return;
    }

    // GraphQL v4 (lib/graphql.ts): POST /api/graphql (auth gate above already 401s).
    if (method === 'POST' && path === '/api/graphql') {
      const body = await readBody(req);
      const result = handleGraphQL(body, store);
      sendJson(res, result.status, result.body);
      return;
    }

    // MCP JSON-RPC 2.0 Streamable HTTP (lib/mcp.ts, Phase 5): POST /mcp.
    // DELETE /mcp closes a session best-effort -> 200, empty body.
    // Auth gate above already 401s unauthenticated calls.
    if (method === 'DELETE' && path === '/mcp') {
      res.writeHead(200, { 'X-GitHub-Request-Id': nextRequestId(), 'content-length': '0' });
      res.end();
      return;
    }
    if (method === 'POST' && path === '/mcp') {
      const body = await readBody(req);
      const result = handleMcp(body, store);
      if (result.text === null) {
        res.writeHead(result.status, { 'X-GitHub-Request-Id': nextRequestId(), 'content-length': '0' });
        res.end();
        return;
      }
      sendRaw(res, result.status, { 'content-type': JSON_TYPE }, Buffer.from(result.text, 'utf8'));
      return;
    }

    // Everything else, every method: GitHub's 404 body.
    sendJson(res, 404, { message: 'Not Found' });
  }

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch(() => {
      try {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.destroy();
      } catch {
        try {
          res.destroy();
        } catch {
          // Nothing left to do for this socket.
        }
      }
    });
  });
}
