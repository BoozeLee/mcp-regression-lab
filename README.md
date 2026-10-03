# mcp-regression-lab

Catch MCP releases that silently break agents. Snapshot a remote MCP server's tool contract,
diff it against the last release, lint it for things that hurt tool selection, and re-run
golden "prompt → expected tool" tests on a **local** model.

- **Deterministic:** contract diff (tool removed/renamed, argument type change, required ↔ optional,
  new required argument, description change). `diff` exits 1 on breaking changes, so it can gate CI.
- **Heuristic:** hygiene lint (thin descriptions, untyped/undocumented args, injection-like text).
- **Probabilistic:** golden tool-selection tests via Ollama, N runs each, reported as pass rates.
  The model is only asked which tool it _would_ call; the server's tools are never executed.

Remote streamable-HTTP servers only. Bearer token via `MCP_TOKEN` env var; it is never written to disk,
and URL query strings are stripped from saved contracts.

## Usage (Node ≥ 24, no build step)

```sh
npm install
node src/cli.ts snapshot https://example.com/mcp -o baseline.json
node src/cli.ts lint baseline.json
# ...after the next release:
node src/cli.ts snapshot https://example.com/mcp -o current.json
node src/cli.ts diff baseline.json current.json          # exit 1 = breaking
node src/cli.ts golden current.json cases.json --model qwen3 --repeat 3 -o golden.json
node src/cli.ts report baseline.json current.json --golden golden.json -o report.html
```

Golden cases (`examples/cases.json`):
`{ "id", "prompt", "expectTool", "requiredArgs"?: string[], "forbiddenTools"?: string[] }`

## Demo

```sh
node examples/demo-server.ts v1   # prints a local URL; v2 simulates a careless release
```

## Development

```sh
npm run build   # tsc type check
npm test        # node:test, includes real HTTP MCP fixture servers
```

## GitHub Action

Wraps the same CLI so a customer's own CI catches a contract regression before merge, with no
hosting on your side (`action.yml`, composite action, runs inside their runner):

```yaml
# .github/workflows/mcp-contract.yml (customer's repo)
on: pull_request
permissions: { pull-requests: write }
jobs:
  contract-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: BoozeLee/mcp-regression-lab@v1
        with:
          mcp-url: https://your-mcp-server.example.com/mcp
          baseline: .mcp-contract.json # commit this once via `snapshot`
```

It snapshots the live server, diffs + lints against the committed baseline, posts/updates one PR
comment (`scripts/post-comment.ts`, plain `fetch` against the GitHub REST API — no SDK), and
**fails the check on any breaking change**.

**Hosted mode** — approved baseline + golden tests, managed at https://mcp-regression-lab.vercel.app:

```yaml
- uses: BoozeLee/mcp-regression-lab@v1
  with:
    api-token: ${{ secrets.MCP_REGRESSION_LAB_TOKEN }} # Settings → API tokens
    server-id: <id from the server's dashboard URL>
```

Fails on a breaking change or a golden-test pass-rate drop. Outputs: `breaking-changes`, `golden-regressions`.

### Version selection

- `BoozeLee/mcp-regression-lab@v1` follows the latest backwards-compatible v1 release.
- `BoozeLee/mcp-regression-lab@v1.0.0` pins the current synced release (both tags retagged 2026-10 while zero installs predate the sync).
- Pin to a full commit SHA when your organization requires the strongest dependency-integrity
  control; verify the SHA against the matching GitHub release before adoption.

## Security and support

Do not include MCP tokens, model keys, API tokens, or server credentials in issues, pull requests,
or contract artifacts. Read [SECURITY.md](SECURITY.md) before reporting a vulnerability and
[CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change.
