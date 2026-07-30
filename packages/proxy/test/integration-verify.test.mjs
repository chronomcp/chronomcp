// `chronomcp verify` command (audit verifiable from the outside): recomputes the
// SHA-256 chain of the audit log with the SAME logic as AuditLog and reports
// integrity on stderr. Exit 0 = intact; 1 = tampered/unreadable.
// The binary's stdout stays EMPTY (reserved for the JSON-RPC of guard mode).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, verifyChain } from "../dist/audit.js";
import { CLI } from "./helpers.mjs";

function freshAudit() {
  const path = join(mkdtempSync(join(tmpdir(), "chronomcp-verify-")), "audit.jsonl");
  const log = new AuditLog(path);
  log.write("session_start", { server: "verify-test" });
  log.write("tool_call_proposed", { tool: "delete_record", class: "destructive" });
  log.write("session_end", { childExitCode: 0 });
  return path;
}

function runVerify(path) {
  const res = spawnSync("node", [CLI, "verify", path], { encoding: "utf8" });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

test("verify: intact chain → exit 0, count on stderr, empty stdout", () => {
  const path = freshAudit();
  const { code, stdout, stderr } = runVerify(path);
  assert.equal(code, 0);
  assert.match(stderr, /chain intact: 3 entr/);
  assert.equal(stdout, ""); // the binary's stdout is EXCLUSIVE to JSON-RPC
});

test("verify: tampered line → exit 1 pointing at the entry (hash does not match)", () => {
  const path = freshAudit();
  const lines = readFileSync(path, "utf8").trim().split("\n");
  // tampering: disguise the destructive action in entry 2
  const tampered = JSON.parse(lines[1]);
  tampered.data.tool = "list_records";
  lines[1] = JSON.stringify(tampered);
  writeFileSync(path, lines.join("\n") + "\n", "utf8");

  const { code, stderr } = runVerify(path);
  assert.equal(code, 1);
  assert.match(stderr, /TAMPERING detected at entry #2/);
  assert.match(stderr, /hash mismatch/);
});

test("verify: removed line → exit 1 (prev_hash broken on the following entry)", () => {
  const path = freshAudit();
  const lines = readFileSync(path, "utf8").trim().split("\n");
  lines.splice(1, 1); // remove the middle entry
  writeFileSync(path, lines.join("\n") + "\n", "utf8");

  const { code, stderr } = runVerify(path);
  assert.equal(code, 1);
  assert.match(stderr, /TAMPERING detected at entry #2/);
  assert.match(stderr, /prev_hash broken/);
});

test("verify: a line that is not JSON → exit 1", () => {
  const path = freshAudit();
  writeFileSync(path, readFileSync(path, "utf8") + "{garbage…\n", "utf8");
  const { code, stderr } = runVerify(path);
  assert.equal(code, 1);
  assert.match(stderr, /TAMPERING detected at entry #4/);
  assert.match(stderr, /not valid JSON/);
});

test("verify: nonexistent file → exit 1 with a readable message", () => {
  const { code, stderr } = runVerify(join(tmpdir(), "does-not-exist", "audit.jsonl"));
  assert.equal(code, 1);
  assert.match(stderr, /could not read/);
});

test("verifyChain (reusable function): same logic as AuditLog", () => {
  const path = freshAudit();
  const entries = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(verifyChain(entries), { ok: true, entries: 3 });

  entries[1].data.class = "read"; // in-memory tampering
  const bad = verifyChain(entries);
  assert.equal(bad.ok, false);
  assert.equal(bad.brokenAt, 1);
  assert.equal(bad.reason, "hash");
});
