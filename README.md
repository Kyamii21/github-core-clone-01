# github-core-clone-01 — GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Kyamii21/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Kyamii21/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)


A standalone git forge in a single Node process, standard library only.
No git binary, no network, no dependencies at runtime.

## Surfaces

- **Git smart HTTP** (`/Kyamii21/github-core-clone-01.git`): upload-pack protocol v2
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

## Run locally

```sh
MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types main.ts
```

Then drive it with the kit's conformance runner from the kit directory:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token test-token --json
```
---

<sub>Entered on [make.fun](https://make.fun/?ref=rhb2d3y3&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
