import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../dist/audit.js";
import { verifyAuditChain } from "./helpers.mjs";

function freshPath() {
  return join(mkdtempSync(join(tmpdir(), "chronomcp-audit-")), "audit.jsonl");
}

function readEntries(path) {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("an intact chain is verifiable by a third party (no access to the code)", async () => {
  const path = freshPath();
  const log = new AuditLog(path);
  log.write("session_start", { server: "t" });
  log.write("tool_call_proposed", { tool: "create_record", class: "mutating" });
  log.write("session_end", { childExitCode: 0 });

  const entries = readEntries(path);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].prevHash, "GENESIS");
  const check = await verifyAuditChain(entries);
  assert.deepEqual(check, { ok: true });
});

test("tampering with any line breaks the chain from there onward", async () => {
  const path = freshPath();
  const log = new AuditLog(path);
  log.write("session_start", { server: "t" });
  log.write("tool_call_proposed", { tool: "delete_record", class: "destructive" });
  log.write("session_end", { childExitCode: 0 });

  const entries = readEntries(path);
  entries[1].data.tool = "list_records"; // tampering: disguise the destructive action
  const check = await verifyAuditChain(entries);
  assert.equal(check.ok, false);
  assert.equal(check.brokenAt, 1);
});

test("reopening the log continues the chain from the last hash", async () => {
  const path = freshPath();
  const log1 = new AuditLog(path);
  log1.write("session_start", { server: "a" });
  const lastHash = readEntries(path).at(-1).hash;

  const log2 = new AuditLog(path); // new process, same file
  log2.write("session_start", { server: "b" });

  const entries = readEntries(path);
  assert.equal(entries[1].prevHash, lastHash);
  assert.deepEqual(await verifyAuditChain(entries), { ok: true });
});

test("a corrupted tail does not crash the process and is flagged", () => {
  const path = freshPath();
  writeFileSync(path, '{"broken json…\n', "utf8");
  const log = new AuditLog(path);
  log.write("session_start", { server: "t" });
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const entry = JSON.parse(lines[1]);
  assert.equal(entry.prevHash, "CORRUPTED_TAIL");
});

test("the hash preimage is a pinned wire format, not an implementation detail", async () => {
  // A third party verifying the chain in Python or Go has only the bytes on the
  // line. This test pins those bytes so a refactor cannot silently change the
  // preimage: key order, the exclusion of `hash`, and the fact that `prevHash`
  // lives INSIDE the hashed object (it is not concatenated separately).
  const { createHash } = await import("node:crypto");
  const path = freshPath();
  const log = new AuditLog(path);
  log.write("tool_call_proposed", { tool: "a/b", note: "café" });

  const [entry] = readEntries(path);

  // 1. Key order on the wire, with `hash` appended last.
  assert.deepEqual(Object.keys(entry), ["ts", "event", "data", "prevHash", "hash"]);

  // 2. The preimage is the same line with `hash` removed, nothing else.
  const preimage =
    `{"ts":${JSON.stringify(entry.ts)},"event":"tool_call_proposed",` +
    `"data":{"tool":"a/b","note":"café"},"prevHash":"GENESIS"}`;
  assert.equal(createHash("sha256").update(preimage).digest("hex"), entry.hash);

  // 3. No canonicalisation: `/` stays unescaped and non-ASCII stays raw UTF-8.
  //    An external implementation that escapes either one computes a different
  //    hash, so these are part of the contract.
  assert.ok(preimage.includes('"tool":"a/b"'));
  assert.ok(preimage.includes("café"));
});
