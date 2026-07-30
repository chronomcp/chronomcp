// Universality: the guard against REAL third-party MCP servers, with no prior
// knowledge of them. Proves that interception, classification and passthrough
// work with any server in the ecosystem.
// Servers without an API key: memory, everything, sequential-thinking.
// npx unavailable/offline → tests are skipped (as in filesystem).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestClient } from "./helpers.mjs";

const NPX_TIMEOUT = 90000;

async function connect(mode, pkg, { env, extraFlags } = {}) {
  const c = new TestClient({
    mode,
    extraFlags,
    serverCmd: ["npx", "-y", pkg],
  });
  if (env) {
    // TestClient does not expose env; servers that need it use defaults — see each test
  }
  try {
    await c.initialize({ timeoutMs: NPX_TIMEOUT });
  } catch (e) {
    await c.close();
    throw Object.assign(new Error(`server unavailable: ${pkg}`), { skip: true, cause: e });
  }
  return c;
}

// ---------------------------------------------------------------- memory

test("universal/memory: a mutation is blocked in gate, runs in log, destructive in block", { timeout: NPX_TIMEOUT * 3 }, async (t) => {
  let c;
  try {
    c = await connect("gate", "@modelcontextprotocol/server-memory");
  } catch (e) {
    if (e.skip) return t.skip(e.message);
    throw e;
  }
  try {
    const tools = await c.listTools({ timeoutMs: NPX_TIMEOUT });
    assert.ok(tools.some((tl) => tl.name === "create_entities"));

    // create_entities: no mcp-compensate, heuristic → mutating → gate without a TTY denies
    const denied = await c.callTool(
      "create_entities",
      { entities: [{ name: "Teste", entityType: "pessoa", observations: ["obs"] }] },
      { timeoutMs: NPX_TIMEOUT },
    );
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /ChronoMCP guard/);

    // a read passes even in gate mode
    const graph = await c.callTool("read_graph", {}, { timeoutMs: NPX_TIMEOUT });
    assert.equal(graph.result.isError, undefined);
  } finally {
    await c.close();
  }

  // block: delete_entities is destructive per the heuristic → denied
  let c2;
  try {
    c2 = await connect("block", "@modelcontextprotocol/server-memory");
  } catch (e) {
    if (e.skip) return t.skip(e.message);
    throw e;
  }
  try {
    await c2.listTools({ timeoutMs: NPX_TIMEOUT });
    const denied = await c2.callTool("delete_entities", { entityNames: ["X"] }, { timeoutMs: NPX_TIMEOUT });
    assert.equal(denied.result.isError, true);

    // and the mutating one passes in block mode (only destructive calls are denied)
    const ok = await c2.callTool(
      "create_entities",
      { entities: [{ name: "Ana", entityType: "pessoa", observations: ["dev"] }] },
      { timeoutMs: NPX_TIMEOUT },
    );
    assert.equal(ok.result.isError, undefined);
  } finally {
    await c2.close();
  }
});

// ---------------------------------------------------------------- everything

test("universal/everything: tools, prompts and resources pass through intact", { timeout: NPX_TIMEOUT * 2 }, async (t) => {
  let c;
  try {
    c = await connect("gate", "@modelcontextprotocol/server-everything");
  } catch (e) {
    if (e.skip) return t.skip(e.message);
    throw e;
  }
  try {
    const tools = await c.listTools({ timeoutMs: NPX_TIMEOUT });
    assert.ok(tools.some((tl) => tl.name === "echo"));

    // echo and get-sum: kebab-case with no mutating verb → read → they pass the gate
    // without friction, even without a TTY (a read is never blocked)
    const echo = await c.callTool("echo", { message: "chronomcp" }, { timeoutMs: NPX_TIMEOUT });
    assert.match(JSON.stringify(echo.result.content), /chronomcp/);
    const sum = await c.callTool("get-sum", { a: 20, b: 22 }, { timeoutMs: NPX_TIMEOUT });
    assert.match(JSON.stringify(sum.result), /42/);

    // transparency beyond tools: prompts and resources are left untouched
    const prompts = await c.request("prompts/list", undefined, { timeoutMs: NPX_TIMEOUT });
    assert.ok(Array.isArray(prompts.result?.prompts));
    const resources = await c.request("resources/list", undefined, { timeoutMs: NPX_TIMEOUT });
    assert.ok(Array.isArray(resources.result?.resources));
  } finally {
    await c.close();
  }
});

// ---------------------------------------------------------------- sequential-thinking

test("universal/sequential-thinking: an explicit readOnlyHint beats the conservative fallback", { timeout: NPX_TIMEOUT * 2 }, async (t) => {
  // "sequentialthinking" has no recognized verb in its name — the conservative
  // fallback would treat it as mutating. BUT the server declares
  // annotations.readOnlyHint=true, and explicit metadata beats the heuristic:
  // it classifies as read and flows without friction even in gate mode. This is
  // exactly the intended incentive: servers that declare do not pay the cost of
  // the unknown (the pure fallback is covered in unit-classify).
  let c;
  try {
    c = await connect("gate", "@modelcontextprotocol/server-sequential-thinking");
  } catch (e) {
    if (e.skip) return t.skip(e.message);
    throw e;
  }
  try {
    const tools = await c.listTools({ timeoutMs: NPX_TIMEOUT });
    const name = tools[0]?.name;
    assert.ok(name);

    const res = await c.callTool(
      name,
      { thought: "primeiro passo", nextThoughtNeeded: false, thoughtNumber: 1, totalThoughts: 1 },
      { timeoutMs: NPX_TIMEOUT },
    );
    assert.equal(res.result.isError, undefined);

    const prop = c.auditEntries().find((e) => e.event === "tool_call_proposed" && e.data.tool === name);
    assert.ok(prop);
    assert.equal(prop.data.class, "read"); // explicit annotation, not the heuristic
  } finally {
    await c.close();
  }
});
