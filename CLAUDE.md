# CLAUDE.md — chronomcp (OSS)

Context for coding agents working in this repo. Engineering rules — breaking any one = PR rejected.

## Inviolable rules

1. **The proxy's stdout belongs exclusively to JSON-RPC.** Any `console.log`/banner on stdout corrupts the MCP stream. Human UI → stderr. Audit → file.
2. **No LLM in the rollback path.** Compensation is 100% deterministic (static `toolName` + `parameterMapping`). It is the defense against prompt injection. Do not "improve" it with AI.
3. **Never declare reversible what isn't.** Without `mcp-compensate` → reversibility is UNKNOWN, never inferred as safe.
4. **`packages/proxy` stays zero runtime dependencies.** A new dependency requires written justification in the PR.
5. **MCP compatibility first.** The proxy is transparent; never break the passthrough to add a feature.

## Conventions

- TypeScript strict, ESM, `NodeNext`; Node ≥ 18. No unjustified `any`.
- Small, imperative commits with a scope prefix: `proxy:`, `spec:`, `examples:`, `docs:`.
- Every behavior change = new/updated test (`node:test`, zero deps) + a README line if it affects usage.
- A SPEC change → update the JSON Schema and the demo server in the SAME PR.

## Commands

```bash
pnpm install
pnpm -r typecheck        # required before every commit
pnpm test                # full suite (unit + real integration)
node packages/proxy/dist/cli.js guard --mode gate --saga -- node examples/server-demo/server.mjs
```
