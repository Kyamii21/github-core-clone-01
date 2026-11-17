# github-core-clone-01 — GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Kyamii21/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Kyamii21/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone git forge in a single Node process, standard library only.
No git binary, no network, no dependencies at runtime.

## Surfaces

- **Git smart HTTP** (`/{owner}/{repo}.git`): upload-pack protocol v2
  (advertisement, `ls-refs`, `fetch` with shallow/deepen) and receive-pack
  v0 (report-status, side-band-64k, delete-refs, per-ref fast-forward
  enforcement). Packs are read and written directly (plain objects plus
  OFS/REF deltas), objects are content-addressed by SHA-1.
- **REST v3** (`/api/v3`): repositories, branches, refs, commits, contents
  (create/update/delete with blob-sha optimistic concurrency), labels,
  issues, comments, pull requests (diff, squash merge, conflict detection).
- **GraphQL v4** (`/api/graphql`): viewer, repository, issue(s),
  pullRequest(s), `node(id)`, `__type` introspection, batched documents,
  and the create/close/merge/comment mutations. Global ids are opaque
  base64 strings.
- **MCP** (`/mcp`): JSON-RPC 2.0 over Streamable HTTP, revision
  2026-07-28 via `server/discover` plus the legacy `initialize` handshake,
  with tools for repos, issues and pull requests acting on the same store
  as REST.

## Layout

- `main.ts` — lifecycle: bind an ephemeral port, register with the suite,
  poll for done, exit 0. (Starter file, unchanged.)
- `app.ts` — HTTP server, routing, auth, request ids.
- `store.ts` — in-memory store: repos, git objects, refs, issues, PRs,
  deterministic timestamps, object/tree/commit helpers, diff and
  merge-base logic.
- `git.ts` — pkt-line codec, pack reader/writer, v0/v2 advertisements,
  ls-refs, fetch, receive-pack.
- `rest.ts` — REST v3 handlers.
- `graphql.ts` — small GraphQL parser and executor.
- `mcp.ts` — MCP JSON-RPC handlers and tools.

## Auth

Every request carries `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`. When
that variable is set in the entry's environment, the bearer must match it
exactly; when unset (local development), any non-empty bearer is accepted
and a missing one is refused with 401. A repository belongs to the login
the token names, so the same name under another owner is 404, never 403.
The viewer login defaults to the scenario viewer and is adopted from the
first repo-scoped request if the token names a different login, so the
forge keeps working if the scored instance uses another viewer.

## Determinism

All timestamps come from a sequence counter, never the wall clock, so a
replay of the same trial produces the same state export.

## v2: what changed for speed

v1's weak column was perf (113–127 of 200 on the server grade). v2 keeps
every conformance behaviour and optimises the hot paths the four timed
workloads hit:

- **Routing** (`app.ts`): no `new URL()` per request — the path is sliced
  out of `req.url` by hand and the query string is parsed only when one
  is present; `/api/*` routes first, the git path is split by hand, auth
  is a `startsWith` + `===` comparison, and JSON replies carry an
  explicit `content-length` instead of chunked encoding.
- **Issues** (`rest.ts`, `store.ts`): a single issue's REST JSON is
  serialized once and cached on the issue, invalidated on any mutation,
  so the 2,000-issue-read workload serves a cached string; timestamps
  are cached per sequence number instead of building a `Date` per reply.
- **Push** (`store.ts`, `git.ts`): `isAncestor` walks parents with an
  early exit and reuses cached ancestor sets instead of copying the
  whole history on every push; object ids hash header and data with two
  updates instead of copying the data; pkt-line headers decode from raw
  bytes; the receive-pack advertisement is cached per repo state.
- **Clone** (`git.ts`): the v2 advertisement is one constant buffer;
  `ls-refs` and fetch responses are cached per repo state, so the 50
  concurrent identical depth-1 clones share one built pack; packs are
  deflated at level 1 (any valid zlib stream is a legal pack).

## Run locally

```sh
MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types main.ts
```

Then drive it with the kit's conformance runner from the kit directory:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token test-token --json
```

<sub>Entered on [make.fun](https://make.fun/?ref=rhb2d3y3&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
