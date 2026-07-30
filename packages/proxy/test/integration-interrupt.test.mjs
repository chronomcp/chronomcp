// Rollback on INTERRUPT + durable stack (journal):
//   • SIGINT/SIGTERM with a pending saga → compensation runs BEFORE exit;
//   • CRASH (SIGKILL) leaves the journal on disk; the next session warns;
//   • a clean end of a successful session finalizes the journal (steps = COMMITTED).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TestClient, verifyAuditChain } from "./helpers.mjs";

const JOURNAL_RE = /^saga-[A-Za-z0-9-]+\.json$/;

function journalsIn(dir) {
  return readdirSync(dir).filter((f) => JOURNAL_RE.test(f));
}

function waitExit(proc, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("process did not exit in time")), timeoutMs);
    proc.on("exit", (code, signal) => {
      clearTimeout(t);
      resolve({ code, signal });
    });
  });
}

test("SIGINT with a pending saga: rollback compensates BEFORE exit and finalizes the journal", async () => {
  const c = new TestClient({ mode: "log", saga: true });
  await c.initialize();
  await c.listTools();
  await c.callTool("create_record", { name: "interrompido" });

  // the durable journal exists while the saga is open
  const dir = dirname(c.auditPath);
  assert.equal(journalsIn(dir).length, 1);

  const exited = waitExit(c.proc);
  process.kill(c.proc.pid, "SIGINT");
  const { code } = await exited;
  assert.equal(code, 130); // SIGINT exit code preserved

  const entries = c.auditEntries();
  const started = entries.find((e) => e.event === "rollback_started");
  assert.ok(started, "rollback_started missing");
  assert.equal(started.data.reason, "SIGINT");

  const steps = entries.filter((e) => e.event === "rollback_step");
  assert.deepEqual(
    steps.map((s) => [s.data.toolName, s.data.status]),
    [["create_record", "compensated"]],
  );

  // order: rollback finishes BEFORE session_end (which is the last entry)
  const iFinished = entries.findIndex((e) => e.event === "rollback_finished");
  const iEnd = entries.findIndex((e) => e.event === "session_end" && e.data.reason === "SIGINT");
  assert.ok(iFinished >= 0 && iEnd > iFinished);
  assert.equal(entries.at(-1).event, "session_end");
  assert.deepEqual(await verifyAuditChain(entries), { ok: true });

  // rollback drained the stack → journal removed (nothing pending)
  assert.equal(journalsIn(dir).length, 0);

  // honest warning on the human UI (stderr), never on stdout
  assert.match(c.stderr, /compensating BEFORE exit/);
});

test("a crash (SIGKILL) leaves a durable journal; the next session warns of an incomplete saga", async () => {
  const c1 = new TestClient({ mode: "log", saga: true });
  await c1.initialize();
  await c1.listTools();
  await c1.callTool("create_record", { name: "orfao" });
  const dir = dirname(c1.auditPath);

  const exited = waitExit(c1.proc);
  process.kill(c1.proc.pid, "SIGKILL"); // sem chance de handler: crash real
  await exited;

  // the journal survived the crash with the uncompensated step
  const files = journalsIn(dir);
  assert.equal(files.length, 1);
  const journal = JSON.parse(readFileSync(join(dir, files[0]), "utf8"));
  assert.equal(journal.steps.length, 1);
  assert.equal(journal.steps[0].toolName, "create_record");
  assert.ok(journal.steps[0].compensate); // metadata for manual compensation

  // a new session pointing at the SAME audit → warning on stderr + audited event
  const c2 = new TestClient({ mode: "log", auditPath: c1.auditPath });
  try {
    await c2.initialize();
    assert.match(c2.stderr, /from a previous session — 1 uncompensated/);
    const ev = c2.auditEntries().find((e) => e.event === "stale_saga_journal");
    assert.ok(ev);
    assert.equal(ev.data.steps, 1);
    // the trail is sacred: the file is NOT deleted automatically
    assert.equal(journalsIn(dir).length, 1);
  } finally {
    await c2.close();
  }
});

test("a clean end of a successful session finalizes the journal (no false positive)", async () => {
  const c = new TestClient({ mode: "log", saga: true });
  await c.initialize();
  await c.listTools();
  await c.callTool("create_record", { name: "commit" });
  const dir = dirname(c.auditPath);
  assert.equal(journalsIn(dir).length, 1);

  await c.close(); // client closes the stream: session ends clean → COMMITTED
  assert.equal(journalsIn(dir).length, 0);
});

test("rollback from a tool failure also finalizes the journal (stack drained)", async () => {
  const c = new TestClient({ mode: "log", saga: true });
  try {
    await c.initialize();
    await c.listTools();
    await c.callTool("create_record", { name: "x" });
    const dir = dirname(c.auditPath);
    assert.equal(journalsIn(dir).length, 1);

    const failed = await c.callTool("charge_payment", { amount: 500, customer: "y" });
    assert.equal(failed.result.isError, true); // rollback already ran

    assert.equal(journalsIn(dir).length, 0);
  } finally {
    await c.close();
  }
});
