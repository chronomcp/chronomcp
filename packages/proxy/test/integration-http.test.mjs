// Streamable HTTP transport: the guard bridges the local
// stdio client and a remote HTTP MCP server. The fake server below exercises:
// a direct JSON response, an SSE response, Mcp-Session-Id, and the saga with
// compensation crossing the HTTP transport.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { TestClient } from "./helpers.mjs";

const COMPENSATE_KEY = "dev.chronomcp/compensate";

/** Mini Streamable HTTP MCP server with in-memory state. */
function startFakeHttpServer({ sseForCalls = false } = {}) {
  const state = {
    records: new Map(),
    seq: 0,
    received: [], // methods that actually reached the server
    sessionIds: new Set(),
    deletes: 0,
  };

  const tools = [
    {
      name: "create_record",
      inputSchema: { type: "object", properties: { name: { type: "string" } } },
      _meta: {
        [COMPENSATE_KEY]: {
          reversibility: "compensable",
          compensation: { toolName: "delete_record", parameterMapping: { id: "$.output.structuredContent.id" } },
        },
      },
    },
    {
      name: "delete_record",
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
      _meta: { [COMPENSATE_KEY]: { reversibility: "irreversible" } },
    },
    {
      name: "charge_payment",
      inputSchema: { type: "object", properties: { amount: { type: "number" } } },
      _meta: { [COMPENSATE_KEY]: { reversibility: "irreversible" } },
    },
    {
      name: "list_records",
      inputSchema: { type: "object", properties: {} },
      _meta: { [COMPENSATE_KEY]: { reversibility: "readonly" } },
    },
  ];

  function handle(msg) {
    state.received.push(msg.method);
    if (msg.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {}, extensions: { [COMPENSATE_KEY]: { version: "0.1" } } },
          serverInfo: { name: "fake-http-mcp", version: "0" },
        },
      };
    }
    if (msg.method === "tools/list") {
      return { jsonrpc: "2.0", id: msg.id, result: { tools } };
    }
    if (msg.method === "tools/call") {
      const { name, arguments: args = {} } = msg.params ?? {};
      if (name === "create_record") {
        const id = `rec_${++state.seq}`;
        state.records.set(id, args.name);
        return { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: id }], structuredContent: { id } } };
      }
      if (name === "delete_record") {
        state.records.delete(args.id);
        return { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "apagado" }] } };
      }
      if (name === "charge_payment") {
        return { jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: "recusado" }] } };
      }
      if (name === "list_records") {
        return { jsonrpc: "2.0", id: msg.id, result: { content: [], structuredContent: { count: state.records.size } } };
      }
      return { jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: "ferramenta desconhecida" }] } };
    }
    if (msg.id !== undefined) return { jsonrpc: "2.0", id: msg.id, result: {} };
    return null; // notification
  }

  const server = createServer((req, res) => {
    if (req.method === "DELETE") {
      state.deletes++;
      res.writeHead(204).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body);
      const sid = req.headers["mcp-session-id"];
      if (sid) state.sessionIds.add(sid);
      const reply = handle(msg);
      if (!reply) {
        res.writeHead(202).end();
        return;
      }
      const headers = { "mcp-session-id": "sess-fake-1" };
      if (sseForCalls && msg.method === "tools/call") {
        res.writeHead(200, { ...headers, "content-type": "text/event-stream" });
        res.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
        res.end();
        return;
      }
      res.writeHead(200, { ...headers, "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ state, server, url: `http://127.0.0.1:${server.address().port}/mcp` });
    });
  });
}

function httpClient(url, opts = {}) {
  return new TestClient({
    mode: "log",
    ...opts,
    serverCmd: null,
    extraFlags: ["--http", url, ...(opts.extraFlags ?? [])],
  });
}

test("http: stdio→HTTP bridge with initialize, tools/list and call (direct JSON)", async () => {
  const { state, server, url } = await startFakeHttpServer();
  const c = httpClient(url);
  try {
    const init = await c.initialize();
    assert.equal(init.result.serverInfo.name, "fake-http-mcp");

    const tools = await c.listTools();
    assert.equal(tools.length, 4);

    const created = await c.callTool("create_record", { name: "via-http" });
    assert.equal(created.result.structuredContent.id, "rec_1");
    assert.ok(state.sessionIds.has("sess-fake-1")); // session propagated on subsequent POSTs
  } finally {
    await c.close();
    server.close();
  }
});

test("http: an SSE response is parsed and delivered to the stdio client", async () => {
  const { server, url } = await startFakeHttpServer({ sseForCalls: true });
  const c = httpClient(url);
  try {
    await c.initialize();
    await c.listTools();
    const created = await c.callTool("create_record", { name: "sse" });
    assert.equal(created.result.structuredContent.id, "rec_1");
  } finally {
    await c.close();
    server.close();
  }
});

test("http: gate mode without a TTY denies a mutation WITHOUT touching the remote server", async () => {
  const { state, server, url } = await startFakeHttpServer();
  const c = httpClient(url, { mode: "gate" });
  try {
    await c.initialize();
    await c.listTools();
    const res = await c.callTool("create_record", { name: "nunca" });
    assert.equal(res.result.isError, true);
    assert.ok(!state.received.some((m, i) => m === "tools/call"));
  } finally {
    await c.close();
    server.close();
  }
});

test("http: a saga with real compensation crosses the transport", async () => {
  const { state, server, url } = await startFakeHttpServer();
  const c = httpClient(url, { saga: true });
  try {
    await c.initialize();
    await c.listTools();
    await c.callTool("create_record", { name: "pedido" });
    assert.equal(state.records.size, 1);

    const failed = await c.callTool("charge_payment", { amount: 500 });
    assert.equal(failed.result.isError, true);

    // rollback over HTTP: delete_record reached the server and the record is gone
    const list = await c.callTool("list_records");
    assert.equal(list.result.structuredContent.count, 0);

    const steps = c.auditEntries().filter((e) => e.event === "rollback_step");
    assert.equal(steps[0].data.status, "compensated");
  } finally {
    await c.close();
    server.close();
  }
});

test("http: upstream down → synthesized JSON-RPC error, client does not hang", async () => {
  const c = httpClient("http://127.0.0.1:59999/mcp"); // port with no server
  try {
    const res = await c.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    assert.ok(res.error);
    assert.match(res.error.message, /upstream HTTP unavailable/);
  } finally {
    await c.close();
  }
});
