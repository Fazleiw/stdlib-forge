# forge-griffin

A GitHub-compatible git forge in one Node 22 process, standard library only: git smart HTTP
(upload-pack v2 and v0, receive-pack v0), REST v3 under `/api/v3`, GraphQL v4 at `/api/graphql` and
an MCP endpoint at `/mcp`, all over one in-memory store.

- `main.ts` - lifecycle (bind port 0, register with the env, poll `/done`)
- `app.ts` - HTTP routing and auth
- `src/git.ts` - objects, packs, pkt-lines; `src/smart.ts` - smart HTTP
- `src/store.ts` - the model; `src/rest.ts`, `src/graphql.ts`, `src/mcp.ts` - the API surfaces

`scripts/run-suite.sh` runs the contest kit's suite against it locally.
