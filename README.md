# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node 22 process (standard library only):
git smart HTTP (upload-pack protocol v2, receive-pack v0), the REST v3 API, GraphQL v4,
and a Model Context Protocol endpoint — all served from one in-memory store, with no UI,
no outside service, and no git binary.

## Run it

```sh
node main.ts
```

The entry binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL/register`, serves
until `GET $MAKEFUN_ENV_URL/done` says done, then exits 0. It answers `GET /healthz`
with `{"ok": true}`.

## Layout

- `main.ts` — the entry/env lifecycle (bind, register, wait for done).
- `app.ts` — the HTTP router: health, git, REST, GraphQL, MCP.
- `gitproto.ts` — pkt-line framing, git objects, packfile read/write.
- `gitserver.ts` — smart HTTP: info/refs, upload-pack v2/v0, receive-pack v0.
- `store.ts` — the shared in-memory store (repos, refs, objects, issues, PRs).
- `rest.ts` — REST v3: repos, branches, commits, contents, labels, issues, pulls.
- `graphql.ts` — GraphQL v4: the documents `gh` and `github-mcp-server` send.
- `mcp.ts` — MCP over streamable HTTP: initialize, tools/list, tools/call.
- `scenario.ts` — the seeded viewer identity the suite's checks address.

---

<sub>Entered on [make.fun](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
