# github-core-clone-01

A standalone GitHub-compatible git forge: smart HTTP (git upload-pack /
receive-pack, protocol v2 + v0), REST v3, GraphQL v4, and MCP
(JSON-RPC 2.0 Streamable HTTP), all in one process on Node 22 stdlib only
— no dependencies, no git binary, no network access at runtime.

## Run

```sh
node --experimental-strip-types main.ts
```

Requires Node >= 22.18 and the environment variables the trial platform
provides: `MAKEFUN_ENV_URL`, `MAKEFUN_SHOP_TOKEN`, `MAKEFUN_TRIAL_SEED`,
`MAKEFUN_TRIAL_NOW`. The process binds an ephemeral port, registers it with
the env, serves until the env reports the trial is done, then exits 0.

## Layout

- `main.ts` — lifecycle: bind, register, poll `/done`, exit.
- `app.ts` — HTTP server, route dispatch, auth gate, JSON envelope.
- `lib/store.ts` — in-memory store: repos, refs, objects, issues, PRs.
- `lib/git-objects.ts` — SHA-1 ids, zlib, commit/tree/blob/tag parse+serialize.
- `lib/pack.ts` — pack v2 read/write (OFS/REF delta resolve).
- `lib/pktline.ts` — pkt-line encode/decode, sideband demux.
- `lib/git-http.ts` — smart HTTP: info/refs, upload-pack, receive-pack.
- `lib/rest.ts` — REST v3 routes.
- `lib/graphql.ts` — GraphQL v4 executor.
- `lib/mcp.ts` — MCP tools.
- `lib/util.ts` — deterministic helpers (timestamps come from
  `MAKEFUN_TRIAL_NOW`; no wall clock, no randomness in request handling).

There is no UI. All state is in memory; the store starts empty and repos
are created by API calls during a trial.
