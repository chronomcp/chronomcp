// --remote mode: intent to the control plane, polling for the
// decision, offline fallback = local policy. Fake control plane on node:http.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { TestClient } from "./helpers.mjs";

/**
 * Fake control plane: POST /v1/transactions records; GET .../:id returns
 * PROPOSED for the first `pollsUntilDecision` queries and then `finalStatus`;
 * POST .../:id/result records the outcome report in `state.results`;
 * POST .../:id/compensated records the compensation report in
 * `state.compensations` (contract: { status: "compensated" |
 * "compensation_failed" | "irreversible", detail?: string }).
 */
function startFakeControlPlane({ finalStatus = "APPROVED", pollsUntilDecision = 1, apiKey = "test-key" } = {}) {
  const state = { intents: [], polls: 0, badAuth: 0, results: [], compensations: [] };
  const server = createServer((req, res) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${apiKey}`) {
      state.badAuth++;
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/v1/transactions") {
        state.intents.push(JSON.parse(body));
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, status: "PROPOSED" }));
        return;
      }
      const rm = /^\/v1\/transactions\/([A-Za-z0-9-]+)\/result$/.exec(req.url ?? "");
      if (req.method === "POST" && rm) {
        state.results.push({ method: req.method, url: req.url, transactionId: rm[1], body: JSON.parse(body) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      const cm = /^\/v1\/transactions\/([A-Za-z0-9-]+)\/compensated$/.exec(req.url ?? "");
      if (req.method === "POST" && cm) {
        state.compensations.push({ transactionId: cm[1], body: JSON.parse(body) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      const m = /^\/v1\/transactions\/([A-Za-z0-9-]+)$/.exec(req.url ?? "");
      if (req.method === "GET" && m) {
        state.polls++;
        const status = state.polls >= pollsUntilDecision ? finalStatus : "PROPOSED";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ transaction: { transaction_id: m[1], status }, steps: [] }));
        return;
      }
      res.writeHead(404).end(JSON.stringify({ error: "not_found" }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ state, server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

/** Active wait: the result report is fire-and-forget, arriving just AFTER the reply to the client. */
async function waitUntil(fn, { timeoutMs = 5000, stepMs = 50, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`timeout waiting for ${label} (${timeoutMs}ms)`);
}

function remoteClient(url, opts = {}) {
  return new TestClient({
    mode: "gate", // with --remote, the local gate only applies in the offline fallback
    ...opts,
    extraFlags: [
      "--remote", url,
      "--remote-key", "test-key",
      "--remote-poll-ms", "150",
      "--remote-timeout-ms", "5000",
      ...(opts.extraFlags ?? []),
    ],
  });
}

test("remote: control plane approval lets the mutation through", async () => {
  const { state, server, url } = await startFakeControlPlane({ finalStatus: "APPROVED", pollsUntilDecision: 2 });
  const c = remoteClient(url);
  try {
    await c.initialize();
    await c.listTools();
    const res = await c.callTool("create_record", { name: "aprovado-remoto" }, { timeoutMs: 10000 });
    assert.equal(res.result.isError, undefined);
    assert.equal(res.result.structuredContent.name, "aprovado-remoto");

    // intent recorded with mcp-compensate metadata
    assert.equal(state.intents.length, 1);
    const step = state.intents[0].steps[0];
    assert.equal(step.toolName, "create_record");
    assert.equal(step.reversibility, "compensable");
    assert.equal(step.compensationTool, "delete_record");

    const dec = c.auditEntries().find((e) => e.event === "tool_call_decision" && e.data.tool === "create_record");
    assert.equal(dec.data.decision, "approved");
    assert.equal(dec.data.source, "remote");
    assert.ok(dec.data.transactionId);
  } finally {
    await c.close();
    server.close();
  }
});

test("remote: control plane denial blocks WITHOUT touching the server", async () => {
  const { server, url } = await startFakeControlPlane({ finalStatus: "DENIED" });
  const c = remoteClient(url);
  try {
    await c.initialize();
    await c.listTools();
    const res = await c.callTool("create_record", { name: "negado" }, { timeoutMs: 10000 });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /blocked/);

    const list = await c.callTool("list_records"); // reads never go through the remote
    assert.equal(list.result.structuredContent.count, 0);
  } finally {
    await c.close();
    server.close();
  }
});

test("remote: reads never generate an intent to the control plane", async () => {
  const { state, server, url } = await startFakeControlPlane();
  const c = remoteClient(url);
  try {
    await c.initialize();
    await c.listTools();
    await c.callTool("list_records");
    assert.equal(state.intents.length, 0);
  } finally {
    await c.close();
    server.close();
  }
});

test("remote offline: fallback applies the local policy (gate without a TTY → deny)", async () => {
  const c = remoteClient("http://127.0.0.1:59998"); // dead port
  try {
    await c.initialize();
    await c.listTools();
    const res = await c.callTool("create_record", { name: "x" }, { timeoutMs: 10000 });
    assert.equal(res.result.isError, true); // gate + no TTY + onNoTty=deny

    const dec = c.auditEntries().find((e) => e.event === "tool_call_decision" && e.data.tool === "create_record");
    assert.equal(dec.data.source, "local_fallback");
    assert.match(c.stderr, /unreachable/);
  } finally {
    await c.close();
  }
});

test("remote offline: fallback in log mode lets it through (local policy)", async () => {
  const c = remoteClient("http://127.0.0.1:59998", { mode: "log" });
  try {
    await c.initialize();
    await c.listTools();
    const res = await c.callTool("create_record", { name: "log-fallback" }, { timeoutMs: 10000 });
    assert.equal(res.result.isError, undefined);
  } finally {
    await c.close();
  }
});

test("remote: timeout with no decision denies for safety", async () => {
  const { server, url } = await startFakeControlPlane({ finalStatus: "APPROVED", pollsUntilDecision: 9999 });
  const c = new TestClient({
    mode: "log",
    extraFlags: ["--remote", url, "--remote-key", "test-key", "--remote-poll-ms", "150", "--remote-timeout-ms", "1000"],
  });
  try {
    await c.initialize();
    await c.listTools();
    const res = await c.callTool("create_record", { name: "lento" }, { timeoutMs: 10000 });
    assert.equal(res.result.isError, true);

    const dec = c.auditEntries().find((e) => e.event === "tool_call_decision" && e.data.tool === "create_record");
    assert.equal(dec.data.source, "remote_timeout");
  } finally {
    await c.close();
    server.close();
  }
});

test("remote: --env travels in the intent and PRODUCTION triggers an alert in the impact diff", async () => {
  const { state, server, url } = await startFakeControlPlane({ finalStatus: "APPROVED", pollsUntilDecision: 2 });
  const c = remoteClient(url, { extraFlags: ["--env", "production"] });
  try {
    await c.initialize();
    await c.listTools();
    await c.callTool("create_record", { name: "em-prod" }, { timeoutMs: 10000 });

    // the environment travels in the intent body to the control plane
    assert.equal(state.intents.length, 1);
    assert.equal(state.intents[0].environment, "production");

    // and the human sees the strong PRODUCTION alert before deciding (stderr, never stdout)
    assert.match(c.stderr, /REAL PRODUCTION/);
    assert.match(c.stderr, /ENVIRONMENT: PRODUCTION/);
  } finally {
    await c.close();
    server.close();
  }
});

test("remote: without --env, no environment is injected (field absent) and no alert", async () => {
  const { state, server, url } = await startFakeControlPlane({ finalStatus: "APPROVED", pollsUntilDecision: 2 });
  const c = remoteClient(url);
  try {
    await c.initialize();
    await c.listTools();
    await c.callTool("create_record", { name: "sem-env" }, { timeoutMs: 10000 });
    assert.equal(state.intents.length, 1);
    assert.equal(state.intents[0].environment, undefined);
    assert.doesNotMatch(c.stderr, /ENVIRONMENT:/);
  } finally {
    await c.close();
    server.close();
  }
});

test("remote: success of an approved call reports ok:true at /result (COMMITTED loop)", async () => {
  const { state, server, url } = await startFakeControlPlane({ finalStatus: "APPROVED", pollsUntilDecision: 1 });
  const c = remoteClient(url);
  try {
    await c.initialize();
    await c.listTools();
    const res = await c.callTool("create_record", { name: "commit-me" }, { timeoutMs: 10000 });
    assert.equal(res.result.isError, undefined);

    await waitUntil(() => state.results.length >= 1, { label: "POST /result" });
    assert.equal(state.results.length, 1);
    const report = state.results[0];
    // the report's transactionId is the SAME one recorded in the intent
    assert.equal(report.transactionId, state.intents[0].transactionId);
    assert.equal(report.body.ok, true);
    // useful output: serialized summary of the result (contains the created record)
    assert.match(report.body.output, /commit-me/);
  } finally {
    await c.close();
    server.close();
  }
});

test("remote: failure of an approved tool (isError) reports ok:false at /result (FAILED loop)", async () => {
  const { state, server, url } = await startFakeControlPlane({ finalStatus: "APPROVED", pollsUntilDecision: 1 });
  const c = remoteClient(url);
  try {
    await c.initialize();
    await c.listTools();
    // charge_payment with amount > 100 fails deterministically (isError: true)
    const res = await c.callTool("charge_payment", { amount: 500, customer: "acme" }, { timeoutMs: 10000 });
    assert.equal(res.result.isError, true);

    await waitUntil(() => state.results.length >= 1, { label: "POST /result" });
    assert.equal(state.results.length, 1);
    const report = state.results[0];
    assert.equal(report.transactionId, state.intents[0].transactionId);
    assert.equal(report.body.ok, false);
    assert.match(report.body.output, /exceeds the demo card limit/);
  } finally {
    await c.close();
    server.close();
  }
});

test("local mode (no --remote): no call generates /result on the control plane", async () => {
  const { state, server, url } = await startFakeControlPlane();
  const c = new TestClient({ mode: "log" }); // NO --remote flags; the fake stays up only to listen
  try {
    await c.initialize();
    await c.listTools();
    const res = await c.callTool("create_record", { name: "local-puro" }, { timeoutMs: 10000 });
    assert.equal(res.result.isError, undefined);

    // generous window: if the proxy were going to report, it would have arrived by now
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(state.intents.length, 0);
    assert.equal(state.results.length, 0);
    void url;
  } finally {
    await c.close();
    server.close();
  }
});

test("remote+saga: compensation of approved steps closes the trail at /compensated", async () => {
  const { state, server, url } = await startFakeControlPlane({ finalStatus: "APPROVED", pollsUntilDecision: 1 });
  const c = remoteClient(url, { saga: true });
  try {
    await c.initialize();
    await c.listTools();

    // two remotely-approved steps enter the stack with a transactionId
    const created = await c.callTool("create_record", { name: "aprovado-saga" }, { timeoutMs: 10000 });
    assert.equal(created.result.isError, undefined);
    await c.callTool("send_email", { to: "x@acme.com", subject: "s" }, { timeoutMs: 10000 });
    const createTx = state.intents[0].transactionId;
    const emailTx = state.intents[1].transactionId;

    // third step approved but FAILS on execution → LIFO rollback
    const failed = await c.callTool("charge_payment", { amount: 500, customer: "acme" }, { timeoutMs: 10000 });
    assert.equal(failed.result.isError, true);

    // rollback reports EACH approved step to the control plane (best-effort)
    await waitUntil(() => state.compensations.length >= 2, { label: "POST /compensated" });
    const byTx = Object.fromEntries(state.compensations.map((r) => [r.transactionId, r.body]));
    // send_email is irreversible: reported as such, without faking a reversal
    assert.equal(byTx[emailTx].status, "irreversible");
    // create_record was actually compensated via delete_record
    assert.equal(byTx[createTx].status, "compensated");
    assert.match(byTx[createTx].detail, /delete_record/);

    // and the /result of the failed charge also closed (FAILED loop intact)
    await waitUntil(() => state.results.some((r) => r.body.ok === false), { label: "POST /result (FAILED)" });
  } finally {
    await c.close();
    server.close();
  }
});

test("local saga (offline fallback, no remote tx) never calls /compensated", async () => {
  // control plane comes up LATER: during the calls the proxy is offline and the
  // local policy (log) approves — steps without a transactionId report nothing.
  const c = new TestClient({
    mode: "log",
    saga: true,
    extraFlags: ["--remote", "http://127.0.0.1:59997", "--remote-key", "test-key", "--remote-poll-ms", "150", "--remote-timeout-ms", "3000"],
  });
  try {
    await c.initialize();
    await c.listTools();
    await c.callTool("create_record", { name: "local" }, { timeoutMs: 10000 });
    const failed = await c.callTool("charge_payment", { amount: 500, customer: "x" }, { timeoutMs: 10000 });
    assert.equal(failed.result.isError, true);

    // local rollback happened…
    const steps = c.auditEntries().filter((e) => e.event === "rollback_step");
    assert.equal(steps.find((s) => s.data.toolName === "create_record").data.status, "compensated");
    // …and no rollback_step carries a transactionId (nothing to report)
    assert.ok(steps.every((s) => s.data.transactionId === undefined));
  } finally {
    await c.close();
  }
});

test("remote: timeout with --on-remote-timeout local applies the local policy", async () => {
  // control plane that never decides + log mode: on timeout, the local policy lets it through
  const { server, url } = await startFakeControlPlane({ finalStatus: "APPROVED", pollsUntilDecision: 9999 });
  const c = new TestClient({
    mode: "log",
    extraFlags: [
      "--remote", url, "--remote-key", "test-key",
      "--remote-poll-ms", "150", "--remote-timeout-ms", "1000",
      "--on-remote-timeout", "local",
    ],
  });
  try {
    await c.initialize();
    await c.listTools();
    const res = await c.callTool("create_record", { name: "timeout-local" }, { timeoutMs: 10000 });
    assert.equal(res.result.isError, undefined); // executed via the local policy (log)

    const dec = c.auditEntries().find((e) => e.event === "tool_call_decision" && e.data.tool === "create_record");
    assert.equal(dec.data.source, "local_fallback_timeout");
  } finally {
    await c.close();
    server.close();
  }
});
