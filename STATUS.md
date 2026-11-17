# STATUS

## Last grade-local (kit `grade-local --driver docker`, practice trial 0, live + replay)

| column | value |
|---|---|
| score | 1000 |
| feature | 600 (120/120 conformance checks) |
| agent | 200 (15/15 MCP checks) |
| perf | 200 (push 50, clone 50, read 50, write 50) |
| perf_p50_us | 130635 (93773 on the previous run: machine noise) |
| working | 1 |
| replay | matched (state.json a0e98d49…f1445590, byte for byte) |

Final run at commit ad7d085 on 2026-11-17 (UTC); the same code scored 1000 at 7a251eb too. Groups: git 30/30, repos 15/15, issues 15/15,
pulls 20/20, graphql 20/20, mcp 15/15, protocol 5/5.

Local loop (`scripts/run-suite.sh`, macOS, node 25): push ~80-115 ms, clone ~25-35 ms,
read ~220-380 ms, write ~30-48 ms per round (T_ref/4 is 410 / 67 / 690 / 87 ms).

## Failing checks

None.

## Notes and next steps

- Production runs under gVisor and is several times slower than a laptop; the perf column there
  will depend mostly on the suite's own client. A CPU profile shows the forge's own code is a small
  share of server time (Node's HTTP machinery and writev dominate), and the issue read path measures
  at the same speed as a bare node:http responder.
- Possible future work: more GitHub API surface (not scored), delta compression in served packs.
