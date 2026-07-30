# mcp-compensate — Compensation Metadata Extension (Draft v0.2)

**Status:** Community draft (pre-SEP, Extensions Track).
**Extension identifier:** `dev.chronomcp/compensate` — `{vendor-prefix}/{extension-name}` format from SEP-2133 (Extensions, Final). The version evolves **inside** the settings object; a new identifier (`dev.chronomcp/compensate-v2`) is minted only on a breaking change, following the official extension-versioning guidance.
**Normative base:** Verified against the **final** MCP spec 2026-07-28 (published 2026-07-28). Confirmed aligned with the final text — the extension identifier format `{vendor-prefix}/{extension-name}` with an owned reversed-domain prefix (`chronomcp.dev` → `dev.chronomcp/`); the `_meta` reserved-prefix rule (only a second label of `mcp`/`modelcontextprotocol` is reserved, so `dev.chronomcp/` is valid and unreserved); extension negotiation via the `extensions` capabilities map (server → `server/discover` response; client → `_meta["io.modelcontextprotocol/clientCapabilities"]` per request); versioning inside the settings object with a `-v2` identifier only on a breaking change; and the required graceful-degradation fallback.

> Revision v0.1 → v0.2: identifier migrated from `dev.chronomcp.compensate/v1` to `dev.chronomcp/compensate` (the previous format treated the name as part of the prefix and the version as the name, diverging from the convention of every official extension); added a negotiation section via the capabilities `extensions` map; added a related-work section.
>
> Re-verification (2026-07-28): re-checked against the final published spec (previously the RC). No normative change required — the identifier, negotiation, `_meta` rules, versioning, and fallback all match the final text.

## 1. Problem

MCP standardizes *how* an agent calls tools, but says nothing about *how to undo* a call. In multi-step runs, a failure at step N leaves steps 1..N-1 committed in real systems. Orchestrators (Temporal, Restate, LangGraph) solve this **inside the developer's own code**; there is no **declarative, portable, protocol-level** way for an MCP server to say: "this tool is mutating, and its inverse is that other tool, with these parameters".

## 2. Non-goals (semantic honesty)

- **Compensation ≠ reversal.** A sent email, a published message, a settled payment have no inverse. The extension forces the server to *declare* irreversibility (`reversibility: "irreversible"`), letting gateways/clients require stronger approval — it never pretends to undo the unundoable.
- It does not define transport, an execution engine, or a sandbox. It is **declarative per-tool metadata only**.

## 3. Extension negotiation

Per the *Extension Negotiation* section of the spec (2026-07-28), extensions are announced in the capabilities `extensions` map — key = extension identifier (following the `_meta` key rules, with a mandatory prefix), value = settings object:

```jsonc
// ServerCapabilities (server that supports mcp-compensate)
{
  "capabilities": {
    "tools": {},
    "extensions": {
      "dev.chronomcp/compensate": { "version": "0.1" }
    }
  }
}
```

**Fallback (mandatory to document, per spec):** when one party does not support the extension, the supporting party MUST fall back to core behavior. For `mcp-compensate` the fallback is natural and safe by construction: in the absence of the metadata, a tool's reversibility is **UNKNOWN** — executors MUST NOT infer it as safe. Clients that ignore `_meta` keep working with no change to their flow.

The `dev.chronomcp/` prefix is valid and non-reserved under the spec's `_meta` key rules (reserved prefixes are only those whose second label is `mcp` or `modelcontextprotocol`).

## 4. Specification

An MCP server that supports the extension adds, to each `Tool` returned by `tools/list`, a block in `_meta` under the extension identifier key:

```jsonc
{
  "name": "create_cloud_database_user",
  "description": "Creates a database user with specific permissions.",
  "inputSchema": { "type": "object", "properties": { "username": { "type": "string" }, "role": { "type": "string" } }, "required": ["username", "role"] },
  "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true },
  "_meta": {
    "dev.chronomcp/compensate": {
      "reversibility": "compensable",        // "compensable" | "irreversible" | "readonly"
      "compensation": {
        "toolName": "delete_cloud_database_user",
        "parameterMapping": {                  // restricted JSONPath over the original call
          "username": "$.input.username"
        },
        "timeoutMs": 5000,
        "maxRetries": 3
      },
      "sideEffectScope": ["iam"],             // free-form labels for risk policies
      "notes": "Removes the created user; does not undo already-open sessions."
    }
  }
}
```

### 4.1 Fields

| Field | Type | Required | Semantics |
|---|---|---|---|
| `reversibility` | enum | yes | `readonly` (no effect), `compensable` (a declared inverse exists), `irreversible` (effect with no way back) |
| `compensation.toolName` | string | if `compensable` | Tool **on the same server** that compensates the call |
| `compensation.parameterMapping` | object | if `compensable` | Values extracted from `$.input.*` and `$.output.*` of the original call. Static paths only; LLM-generated content is **forbidden** (defense against prompt injection in rollback) |
| `compensation.timeoutMs` / `maxRetries` | number | no | Execution limits for the compensation |
| `sideEffectScope` | string[] | no | Tags for policy engines (e.g. `payments`, `email`, `infra`) |

### 4.2 Normative rules

1. Compensation executors MUST invoke `toolName` with parameters resolved **exclusively** from `parameterMapping` (deterministic; no LLM in the rollback path).
2. Compensations MUST run in **LIFO** order relative to the successful original calls.
3. If any step in the chain is `irreversible`, the executor MUST report the irreversibility boundary to the user/approver **before** commit (not after the failure).
4. A `parameterMapping` that references `$.output.*` requires the executor to retain the original call result.
5. Servers MUST NOT declare `compensable` when the inverse is only partial without recording the limitation in `notes`.
6. The restricted JSONPath navigates **object properties only** (no array indices). Servers whose compensation depends on result values (e.g. a generated `id`) MUST return them in `structuredContent` — the result's `content[]` array is not addressable.

## 5. Interoperability

- Gateways/proxies (ChronoMCP and any others) consume the metadata without altering the standard MCP flow — clients that ignore `_meta` keep working (backwards-compatible by construction).
- Relationship to native `annotations`: `readOnlyHint`/`destructiveHint`/`idempotentHint` remain the primary source of classification; this extension adds the **how to undo**, which the annotations do not cover.
- Stateless model (SEP-2575, spec 2026-07-28): the per-tool declaration in `tools/list` is session-independent, so it survives the removal of the `initialize` handshake. In the stateless era, the `extensions` announcement happens via `server/discover` (server) and `_meta["io.modelcontextprotocol/clientCapabilities"]` (client); in the legacy era, via `initialize`.

## 6. Related work (and differentiation)

| Proposal | Status | Relationship |
|---|---|---|
| SEP-2624 — Interceptors (`experimental-ext-interceptors`) | in-review | Gate/validation/audit middleware in the agentic loop. Overlaps with the *gateway*; **does not define** compensation, saga, or declarative reversibility — complementary, not competing |
| SEP-1984 — Comprehensive Tool Annotations (`reversibleHint`) | draft, sponsor inactive | Only a boolean reversibility hint; no mechanics for *how* to undo |
| SEP-1610 — Declarative Multi-Step Tool Chaining | issue | Explicitly declares compensation / transactional guarantees **out of scope** |

There is no official or experimental compensation extension in the MCP ecosystem (verified against the RC 2026-07-28 and the `ext-*`/`experimental-ext-*` repositories in July 2026).

## 7. Standardization path (current SEP process)

1. Publish this draft + reference implementation (`packages/proxy` + `examples/server-demo`).
2. Gather feedback from MCP server authors (issues in this repo) and discuss with the relevant WG/IG on the official Discord **before** submitting (cold submissions are discouraged).
3. Submit the SEP via PR (a file under `seps/` in `modelcontextprotocol/modelcontextprotocol`, type **Extensions Track**), with the mandatory template sections (Abstract, Motivation, Specification in RFC 2119, Rationale, Backward Compatibility, Reference Implementation, Security Implications).
4. Extensions Track requirements before review: **at least one reference implementation in an official SDK** and association with a working/interest group. The proxy alone does not satisfy this — plan a reference contribution to an SDK (e.g. the TypeScript SDK) as part of the submission.
5. If accepted, migrate the namespace to the official one (`io.modelcontextprotocol/...`) at graduation.

## 8. JSON Schema

See [`schema/mcp-compensate.schema.json`](./schema/mcp-compensate.schema.json).
