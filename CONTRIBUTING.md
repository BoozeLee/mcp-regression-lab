# Contributing

Keep the contract diff deterministic and treat golden tool-selection results as probabilistic.
Do not commit MCP tokens, model keys, API tokens, server credentials, or real contract artifacts.

Before opening a pull request, run:

```sh
npm ci --ignore-scripts
npm run build
npm test
```

Describe the user-visible behavior, include regression coverage for behavior changes, and keep
unrelated refactors out of the pull request. Changes to `action.yml` or workflows must preserve
least-privilege permissions and use full commit SHAs for third-party actions.
