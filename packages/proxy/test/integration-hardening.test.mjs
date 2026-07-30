// Hardening: clean shutdown on signals, line-size limit
// (OOM protection) and grace-kill of a stubborn child.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TestClient, verifyAuditChain } from "./helpers.mjs";

function waitExit(proc, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("process did not exit in time")), timeoutMs);
    proc.on("exit", (code, signal) => {
      clearTimeout(t);
      resolve({ code, signal });
    });
  });
}

test("SIGTERM: audits session_end, terminates the child and exits with 143", async () => {
  const c = new TestClient({ mode: "log" });
  await c.initialize();
  const exited = waitExit(c.proc);
  process.kill(c.proc.pid, "SIGTERM");
  const { code } = await exited;
  assert.equal(code, 143);

  const entries = c.auditEntries();
  const last = entries.at(-1);
  assert.equal(last.event, "session_end");
  assert.equal(last.data.reason, "SIGTERM");
  assert.deepEqual(await verifyAuditChain(entries), { ok: true });
});

test("SIGINT: exits with 130 and records the reason", async () => {
  const c = new TestClient({ mode: "log" });
  await c.initialize();
  const exited = waitExit(c.proc);
  process.kill(c.proc.pid, "SIGINT");
  const { code } = await exited;
  assert.equal(code, 130);
  assert.equal(c.auditEntries().at(-1).data.reason, "SIGINT");
});

test("a line larger than --max-line-bytes is dropped without killing the session", async () => {
  const c = new TestClient({ mode: "log", extraFlags: ["--max-line-bytes", "4096"] });
  try {
    await c.initialize();

    // giant request (~64KiB) on a single line: it must be dropped
    const huge = { jsonrpc: "2.0", id: 999, method: "tools/call", params: { name: "x", arguments: { pad: "A".repeat(64 * 1024) } } };
    c.send(huge);

    // the session stays alive: a normal call still works
    const ping = await c.request("ping");
    assert.deepEqual(ping.result, {});
    assert.equal(c.messages.find((m) => m.id === 999), undefined);

    assert.ok(c.auditEntries().some((e) => e.event === "oversized_line"));
    assert.match(c.stderr, /OOM protection/);
  } finally {
    await c.close();
  }
});

test("a child that ignores stdin end gets SIGKILL after the grace period", async () => {
  // server that never exits on its own: it ignores the stdin end event
  const c = new TestClient({
    mode: "log",
    serverCmd: ["node", "-e", "process.stdin.resume(); process.stdin.on('end', () => {}); setInterval(() => {}, 1000);"],
  });
  const exited = waitExit(c.proc, 12000);
  c.proc.stdin.end(); // client end → endChild() → 3s grace → SIGKILL
  const { code } = await exited;
  assert.notEqual(code, null); // proxy exited (did not hang)
  assert.match(c.stderr, /SIGKILL/);
});
