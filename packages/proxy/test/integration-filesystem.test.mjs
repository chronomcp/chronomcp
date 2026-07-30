// Integration against a real third-party MCP server (no mcp-compensate):
// @modelcontextprotocol/server-filesystem via npx. Validates passthrough
// transparency and the classification heuristic over snake_case names.
// If npx can't resolve the package (offline), the test is skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestClient } from "./helpers.mjs";

const NPX_TIMEOUT = 60000;

async function fsClient(mode, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "chronomcp-fs-"));
  writeFileSync(join(dir, "hello.txt"), "chronomcp", "utf8");
  const c = new TestClient({
    mode,
    ...extra,
    serverCmd: ["npx", "-y", "@modelcontextprotocol/server-filesystem", dir],
  });
  try {
    await c.initialize().then(
      () => {},
      (e) => {
        throw Object.assign(new Error("npx unavailable"), { skip: true, cause: e });
      },
    );
  } catch (e) {
    await c.close();
    throw e;
  }
  return { c, dir };
}

test("server-filesystem: passthrough + reads pass through intact", { timeout: NPX_TIMEOUT * 2 }, async (t) => {
  let ctx;
  try {
    ctx = await fsClient("gate"); // gate with no TTY: reads must still pass
  } catch (e) {
    if (e.skip) return t.skip("npx/@modelcontextprotocol/server-filesystem unavailable");
    throw e;
  }
  const { c, dir } = ctx;
  try {
    const tools = await c.listTools({ timeoutMs: NPX_TIMEOUT });
    assert.ok(tools.some((tl) => tl.name === "read_text_file" || tl.name === "read_file"));

    const readTool = tools.some((tl) => tl.name === "read_text_file") ? "read_text_file" : "read_file";
    const res = await c.callTool(readTool, { path: join(dir, "hello.txt") }, { timeoutMs: NPX_TIMEOUT });
    assert.equal(res.result.isError, undefined);
    assert.match(JSON.stringify(res.result.content), /chronomcp/);
  } finally {
    await c.close();
  }
});

test("server-filesystem: write_file is blocked in gate mode without a TTY (snake_case heuristic)", { timeout: NPX_TIMEOUT * 2 }, async (t) => {
  let ctx;
  try {
    ctx = await fsClient("gate");
  } catch (e) {
    if (e.skip) return t.skip("npx/@modelcontextprotocol/server-filesystem unavailable");
    throw e;
  }
  const { c, dir } = ctx;
  try {
    await c.listTools({ timeoutMs: NPX_TIMEOUT });
    const res = await c.callTool(
      "write_file",
      { path: join(dir, "novo.txt"), content: "x" },
      { timeoutMs: NPX_TIMEOUT },
    );
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /ChronoMCP guard/);
  } finally {
    await c.close();
  }
});
