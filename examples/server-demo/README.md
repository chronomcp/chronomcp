# chronomcp-demo-server

An example stdio MCP server that fully implements the [`mcp-compensate`](../../spec/mcp-compensate/SPEC.md) extension. Zero dependencies — a single Node ESM file.

It is the reference implementation companion to the spec and the fixture for the proxy's integration test suite.

## Tools

| Tool | Reversibility | Compensation |
|---|---|---|
| `list_records` | `readonly` | — |
| `create_record` | `compensable` | `delete_record` with `id: $.output.structuredContent.id` |
| `delete_record` | `irreversible` | deleted content is not retained |
| `send_email` | `irreversible` | there is no "un-send" |
| `charge_payment` | `irreversible` | a refund would be a NEW transaction, not a reversal. **Deterministic failure when `amount > 100`** (saga trigger for demo/tests) |
| `enable_admin_tools` | `compensable` | `disable_admin_tools`; adds `wipe_all_records` and emits `notifications/tools/list_changed` |
| `disable_admin_tools` | `compensable` | `enable_admin_tools` |
| `wipe_all_records` (dynamic) | `irreversible` | mass destruction |

## Spec point demonstrated

`parameterMapping` over `$.output.*` navigates **object properties only** (static JSONPath-lite, no array indices). The MCP result's `content[]` array is not addressable — that is why the server returns the generated `id` in **`structuredContent`**, which is the recommended pattern for servers that declare result-dependent compensation.

## Run it with the guard

```bash
node packages/proxy/dist/cli.js guard --mode gate --saga -- node examples/server-demo/server.mjs
```

Saga demo walkthrough (via an MCP client):

1. `create_record {name: "order-42"}` → approved, creates `rec_1`
2. `charge_payment {amount: 500, customer: "acme"}` → fails (limit 100)
3. ChronoMCP runs the LIFO rollback **before** forwarding the error: `delete_record {id: "rec_1"}`
4. Honest report on stderr: what was compensated and what is irreversible
