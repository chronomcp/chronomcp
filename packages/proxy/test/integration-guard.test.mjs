// Integration: the real proxy (dist/cli.js) guarding the real demo server
// (examples/server-demo). Covers passthrough, the gate and block policies,
// denial without a TTY, and dynamic tools/list via notifications/tools/list_changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TestClient, verifyAuditChain } from "./helpers.mjs";

test("pure passthrough: initialize, ping and notifications are left untouched", async () => {
  const c = new TestClient({ mode: "log" });
  try {
    const init = await c.initialize();
    assert.equal(init.result.serverInfo.name, "chronomcp-demo-server");
    const ping = await c.request("ping");
    assert.deepEqual(ping.result, {});
    // the proxy's stdout is pure JSON-RPC: the harness already does a strict
    // JSON.parse on every line — any banner on stdout would have broken the asserts above.
  } finally {
    await c.close();
  }
});

test("log mode: a mutation passes without approval and everything is audited", async () => {
  const c = new TestClient({ mode: "log" });
  try {
    await c.initialize();
    await c.listTools();
    const res = await c.callTool("create_record", { name: "log-mode" });
    assert.equal(res.result.isError, undefined);
    assert.equal(res.result.structuredContent.name, "log-mode");

    const events = c.auditEntries().map((e) => e.event);
    assert.ok(events.includes("tool_call_proposed"));
    assert.ok(events.includes("tool_call_decision"));
    assert.ok(events.includes("tool_call_result"));
    assert.deepEqual(await verifyAuditChain(c.auditEntries()), { ok: true });
  } finally {
    await c.close();
  }
});

test("block mode: a destructive call is denied WITHOUT touching the server; a mutating one passes", async () => {
  const c = new TestClient({ mode: "block" });
  try {
    await c.initialize();
    await c.listTools();

    const created = await c.callTool("create_record", { name: "vivo" });
    const id = created.result.structuredContent.id;

    const denied = await c.callTool("delete_record", { id });
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /blocked by the 'block' policy/);

    // proof the server never saw the call: the record is still there
    const list = await c.callTool("list_records");
    assert.equal(list.result.structuredContent.count, 1);

    const decisions = c
      .auditEntries()
      .filter((e) => e.event === "tool_call_decision" && e.data.tool === "delete_record");
    assert.equal(decisions.at(-1).data.decision, "denied");
  } finally {
    await c.close();
  }
});

test("gate mode without a TTY + onNoTty=deny (default): mutation denied", async () => {
  const c = new TestClient({ mode: "gate" });
  try {
    await c.initialize();
    await c.listTools();
    const res = await c.callTool("create_record", { name: "nunca" });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /ChronoMCP guard/);

    const list = await c.callTool("list_records"); // a read passes straight through
    assert.equal(list.result.structuredContent.count, 0);
  } finally {
    await c.close();
  }
});

test("gate mode without a TTY + onNoTty=allow: mutation passes", async () => {
  const c = new TestClient({ mode: "gate", onNoTty: "allow" });
  try {
    await c.initialize();
    await c.listTools();
    const res = await c.callTool("create_record", { name: "liberado" });
    assert.equal(res.result.isError, undefined);
    assert.equal(res.result.structuredContent.name, "liberado");
  } finally {
    await c.close();
  }
});

test("dynamic tools/list: list_changed → re-list indexes a new destructive tool", async () => {
  const c = new TestClient({ mode: "block" });
  try {
    await c.initialize();
    let tools = await c.listTools();
    assert.ok(!tools.some((t) => t.name === "wipe_all_records"));

    await c.callTool("enable_admin_tools"); // mutante: passa no block
    await c.waitFor((m) => m.method === "notifications/tools/list_changed", {
      label: "notifications/tools/list_changed",
    });

    tools = await c.listTools(); // re-list re-indexa no proxy
    assert.ok(tools.some((t) => t.name === "wipe_all_records"));

    // the new tool is destructive (declared irreversible) → block denies it
    const denied = await c.callTool("wipe_all_records");
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /blocked/);
  } finally {
    await c.close();
  }
});
