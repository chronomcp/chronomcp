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
