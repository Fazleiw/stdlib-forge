# stdlib-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Fazleiw/stdlib-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Fazleiw/stdlib-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node 22 process, standard library only: git smart HTTP
(upload-pack v2 and v0, receive-pack v0), REST v3 under `/api/v3`, GraphQL v4 at `/api/graphql` and
an MCP endpoint at `/mcp`, all over one in-memory store.

- `main.ts` - lifecycle (bind port 0, register with the env, poll `/done`)
- `app.ts` - HTTP routing and auth
- `src/git.ts` - objects, packs, pkt-lines; `src/smart.ts` - smart HTTP
- `src/store.ts` - the model; `src/rest.ts`, `src/graphql.ts`, `src/mcp.ts` - the API surfaces

`scripts/run-suite.sh` runs the contest kit's suite against it locally.

## Run it

```sh
MAKEFUN_ENV_URL=http://localhost:8080 MAKEFUN_SHOP_TOKEN=dev node main.ts
```

Entry for make.fun's [Build a GitHub-compatible git forge](https://make.fun/bounty/github-core-clone-01) bounty.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
