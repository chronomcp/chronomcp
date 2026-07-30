// Stateless era (spec 2026-07-28 / SEP-2575): no initialize
// handshake. The guard also indexes tools via server/discover, and the whole
// pipeline (classification via mcp-compensate, block, saga) works without any
// call to initialize or tools/list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TestClient } from "./helpers.mjs";

test("stateless: server/discover indexes tools without initialize or tools/list", async () => {
  const c = new TestClient({ mode: "block" });
  try {
    // NO initialize: the session's first message is the discover
    const disc = await c.request("server/discover");
    assert.equal(disc.result.serverInfo.name, "chronomcp-demo-server");
    assert.ok(Array.isArray(disc.result.tools));
    assert.ok(disc.result.capabilities.extensions["dev.chronomcp/compensate"]);
    assert.match(c.stderr, /tools indexed/);

    // the index came from discover: delete_record is irreversible → block denies
    const denied = await c.callTool("delete_record", { id: "x" });
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /blocked/);

    // and a compensable mutating call passes in block mode
    const ok = await c.callTool("create_record", { name: "stateless" });
    assert.equal(ok.result.structuredContent.name, "stateless");
  } finally {
    await c.close();
  }
});

test("stateless: a complete saga works without initialize", async () => {
  const c = new TestClient({ mode: "log", saga: true });
  try {
    await c.request("server/discover");
    await c.callTool("create_record", { name: "pedido" });
    const failed = await c.callTool("charge_payment", { amount: 500, customer: "x" });
    assert.equal(failed.result.isError, true);

    const list = await c.callTool("list_records");
    assert.equal(list.result.structuredContent.count, 0); // rollback ran

    const steps = c.auditEntries().filter((e) => e.event === "rollback_step");
    assert.equal(steps[0].data.status, "compensated");
  } finally {
    await c.close();
  }
});

test("dual-era: a legacy session (initialize + tools/list) stays intact", async () => {
  const c = new TestClient({ mode: "log" });
  try {
    const init = await c.initialize();
    assert.equal(init.result.serverInfo.name, "chronomcp-demo-server");
    const tools = await c.listTools();
    assert.ok(tools.length >= 7);
  } finally {
    await c.close();
  }
});
