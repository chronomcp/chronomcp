// Integration test harness: a minimal MCP client that speaks NDJSON to the
// chronomcp proxy, which in turn guards a real MCP server.
// Zero dependencies: node:test + node:child_process.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CLI = join(__dirname, "..", "dist", "cli.js");
export const DEMO_SERVER = join(__dirname, "..", "..", "..", "examples", "server-demo", "server.mjs");

export function tmpAuditPath() {
  return join(mkdtempSync(join(tmpdir(), "chronomcp-test-")), "audit.jsonl");
}

/**
 * Test MCP client. `detached: true` starts a new POSIX session: the proxy has
 * NO controlling terminal, so /dev/tty fails and the onNoTty policy is
 * exercised deterministically (it never blocks waiting for a keypress).
 */
export class TestClient {
  constructor({ mode = "log", saga = false, onNoTty, auditPath, serverCmd, extraFlags = [] } = {}) {
    this.auditPath = auditPath ?? tmpAuditPath();
    const flags = ["--mode", mode, "--audit", this.auditPath, "--label", "test", ...extraFlags];
    if (saga) flags.push("--saga");
    if (onNoTty) flags.push("--on-no-tty", onNoTty);
    // serverCmd === null → no stdio command (--http mode, passed via extraFlags)
    const cmd = serverCmd === null ? [] : (serverCmd ?? ["node", DEMO_SERVER]);
    const tail = cmd.length > 0 ? ["--", ...cmd] : [];

    this.proc = spawn("node", [CLI, "guard", ...flags, ...tail], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    this.stderr = "";
    this.proc.stderr.on("data", (d) => (this.stderr += d.toString()));

    this.messages = [];
    this.waiters = [];
    let buf = "";
    this.proc.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line); // stdout MUST be pure JSON-RPC: strict parse
        this.messages.push(msg);
        this.waiters = this.waiters.filter((w) => !w.check(msg));
      }
    });
    this.seq = 0;
  }

  send(msg) {
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  /** Waits for the first message (new or already received) that satisfies the predicate. */
  waitFor(predicate, { timeoutMs = 8000, label = "message" } = {}) {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for ${label} (${timeoutMs}ms)\nstderr:\n${this.stderr}`)),
        timeoutMs,
      );
      this.waiters.push({
        check: (msg) => {
          if (!predicate(msg)) return false;
          clearTimeout(timer);
          resolve(msg);
          return true;
        },
      });
    });
  }

  async request(method, params, { timeoutMs } = {}) {
    const id = ++this.seq;
    this.send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    return this.waitFor((m) => m.id === id && !("method" in m), { timeoutMs, label: method });
  }

  async initialize(opts = { timeoutMs: 30000 }) {
    const res = await this.request(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "chronomcp-test", version: "0" },
      },
      opts,
    );
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return res;
  }

  async listTools(opts) {
    const res = await this.request("tools/list", undefined, opts);
    return res.result.tools;
  }

  async callTool(name, args, opts) {
    return this.request("tools/call", { name, arguments: args ?? {} }, opts);
  }

  auditEntries() {
    return readFileSync(this.auditPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  async close() {
    this.proc.stdin.end();
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try {
          process.kill(-this.proc.pid, "SIGKILL");
        } catch {}
        resolve();
      }, 2000);
      this.proc.on("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

/** Verifies the hash chain of an audit log. Returns { ok, brokenAt }. */
export async function verifyAuditChain(entries) {
  const { createHash } = await import("node:crypto");
  let prev = "GENESIS";
  for (let i = 0; i < entries.length; i++) {
    const { hash, ...body } = entries[i];
    if (body.prevHash !== prev) return { ok: false, brokenAt: i, reason: "prevHash" };
    const recomputed = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    if (recomputed !== hash) return { ok: false, brokenAt: i, reason: "hash" };
    prev = hash;
  }
  return { ok: true };
}
