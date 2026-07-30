// Saga integration: a failure in one step triggers a real LIFO rollback against
// the demo server, BEFORE the error reaches the client, with an honest report
// about what cannot be undone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TestClient, verifyAuditChain } from "./helpers.mjs";

test("saga: a failure triggers real compensation and state returns to the initial one", async () => {
  const c = new TestClient({ mode: "log", saga: true });
  try {
    await c.initialize();
    await c.listTools();

    const created = await c.callTool("create_record", { name: "pedido-42" });
    const id = created.result.structuredContent.id;
    assert.ok(id);

    // amount > 100 → deterministic failure from the demo server
    const failed = await c.callTool("charge_payment", { amount: 500, customer: "acme" });
    assert.equal(failed.result.isError, true);

    // rollback already ran BEFORE the error arrived: record compensated (deleted)
    const list = await c.callTool("list_records");
    assert.equal(list.result.structuredContent.count, 0);

    const entries = c.auditEntries();
    const events = entries.map((e) => e.event);
    assert.ok(events.includes("rollback_started"));
    assert.ok(events.includes("rollback_finished"));

    const steps = entries.filter((e) => e.event === "rollback_step");
    assert.equal(steps.length, 1);
    assert.equal(steps[0].data.toolName, "create_record");
    assert.equal(steps[0].data.status, "compensated");
    assert.match(steps[0].data.detail, /delete_record/);

    // order in the log: rollback_finished BEFORE the following tool_call_result
    assert.deepEqual(await verifyAuditChain(entries), { ok: true });
  } finally {
    await c.close();
  }
});

test("saga: synthetic compensation IDs never leak to the client", async () => {
  const c = new TestClient({ mode: "log", saga: true });
  try {
    await c.initialize();
    await c.listTools();
    await c.callTool("create_record", { name: "x" });
    await c.callTool("charge_payment", { amount: 999, customer: "y" });
    await c.callTool("list_records"); // ensures the post-rollback flow continues

    const leaked = c.messages.filter(
      (m) => typeof m.id === "string" && m.id.startsWith("chronomcp-comp-"),
    );
    assert.equal(leaked.length, 0);
  } finally {
    await c.close();
  }
});

test("saga with an irreversible step: honest report, without faking a reversal", async () => {
  const c = new TestClient({ mode: "log", saga: true });
  try {
    await c.initialize();
    await c.listTools();

    await c.callTool("create_record", { name: "pedido-43" });
    await c.callTool("send_email", { to: "customer@acme.com", subject: "confirmation" });
    const failed = await c.callTool("charge_payment", { amount: 500, customer: "acme" });
    assert.equal(failed.result.isError, true);

    const steps = c.auditEntries().filter((e) => e.event === "rollback_step");
    // LIFO: send_email (irreversible) first, then create_record (compensated)
    assert.deepEqual(
      steps.map((s) => [s.data.toolName, s.data.status]),
      [
        ["send_email", "irreversible"],
        ["create_record", "compensated"],
      ],
    );

    const finished = c.auditEntries().find((e) => e.event === "rollback_finished");
    assert.equal(finished.data.compensated, 1);
    assert.equal(finished.data.irreversible, 1);

    // honest warning on the human UI (stderr), never on stdout
    assert.match(c.stderr, /NO possible reversal/);

    // and the compensable record is really gone
    const list = await c.callTool("list_records");
    assert.equal(list.result.structuredContent.count, 0);
  } finally {
    await c.close();
  }
});

test("saga: success does not trigger rollback and the stack accumulates steps", async () => {
  const c = new TestClient({ mode: "log", saga: true });
  try {
    await c.initialize();
    await c.listTools();
    await c.callTool("create_record", { name: "a" });
    await c.callTool("create_record", { name: "b" });
    await c.callTool("charge_payment", { amount: 50, customer: "ok" }); // within the limit

    const events = c.auditEntries().map((e) => e.event);
    assert.ok(!events.includes("rollback_started"));

    const list = await c.callTool("list_records");
    assert.equal(list.result.structuredContent.count, 2);
  } finally {
    await c.close();
  }
});
