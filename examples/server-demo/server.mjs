#!/usr/bin/env node
// chronomcp-demo-server — example stdio MCP server with full mcp-compensate support.
// Zero dependencies: Node >= 18, NDJSON over stdio.
//
// Tools:
//   list_records       readonly
//   create_record      compensable  → delete_record (id comes from $.output.structuredContent.id)
//   delete_record      irreversible (the record content is not retained)
//   send_email         irreversible (the classic: there is no "un-send")
//   charge_payment     irreversible; fails when amount > 100 (demo card limit)
//   enable_admin_tools compensable  → disable_admin_tools; when enabled, adds
//                      wipe_all_records and emits notifications/tools/list_changed
//
// The create/delete pair + the deterministic charge_payment failure let you
// demonstrate the full ChronoMCP saga: create OK → charge FAILS → rollback
// deletes the created record, and the report flags what has NO way back.

const COMPENSATE_KEY = "dev.chronomcp/compensate";
const PROTOCOL_VERSION = "2025-06-18";

const records = new Map();
let recordSeq = 0;
let adminEnabled = false;
const sentEmails = [];
const payments = [];

// ---------- tool definitions ----------

const baseTools = [
  {
    name: "list_records",
    description: "Lists the records currently in the in-memory store.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    _meta: {
      [COMPENSATE_KEY]: { reversibility: "readonly" },
    },
  },
  {
    name: "create_record",
    description: "Creates a named record and returns the generated id.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    _meta: {
      [COMPENSATE_KEY]: {
        reversibility: "compensable",
        compensation: {
          toolName: "delete_record",
          parameterMapping: { id: "$.output.structuredContent.id" },
          timeoutMs: 5000,
          maxRetries: 2,
        },
        sideEffectScope: ["storage"],
        notes: "Removes the created record; the id is read from the result's structuredContent.",
      },
    },
  },
  {
    name: "delete_record",
    description: "Deletes a record by id. The content is not retained.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
    _meta: {
      [COMPENSATE_KEY]: {
        reversibility: "irreversible",
        sideEffectScope: ["storage"],
        notes: "Deleted content is not recoverable by this server.",
      },
    },
  },
  {
    name: "send_email",
    description: "Sends an email (simulated). There is no 'un-send'.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["to", "subject"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    _meta: {
      [COMPENSATE_KEY]: {
        reversibility: "irreversible",
        sideEffectScope: ["email"],
        notes: "Email delivered to third parties; effect outside the server's control.",
      },
    },
  },
  {
    name: "charge_payment",
    description:
      "Charges a payment (simulated). Fails when amount > 100 (demo card limit).",
    inputSchema: {
      type: "object",
      properties: { amount: { type: "number" }, customer: { type: "string" } },
      required: ["amount", "customer"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    _meta: {
      [COMPENSATE_KEY]: {
        reversibility: "irreversible",
        sideEffectScope: ["payments"],
        notes: "A refund is a NEW transaction, not a reversal — outside the declared scope.",
      },
    },
  },
  {
    name: "enable_admin_tools",
    description:
      "Enables admin tools (adds wipe_all_records and notifies tools/list_changed).",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    _meta: {
      [COMPENSATE_KEY]: {
        reversibility: "compensable",
        compensation: { toolName: "disable_admin_tools", parameterMapping: {} },
        sideEffectScope: ["config"],
      },
    },
  },
  {
    name: "disable_admin_tools",
    description: "Disables the admin tools.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    _meta: {
      [COMPENSATE_KEY]: {
        reversibility: "compensable",
        compensation: { toolName: "enable_admin_tools", parameterMapping: {} },
        sideEffectScope: ["config"],
      },
    },
  },
];

const adminTools = [
  {
    name: "wipe_all_records",
    description: "Deletes ALL records. No way back.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: true },
    _meta: {
      [COMPENSATE_KEY]: {
        reversibility: "irreversible",
        sideEffectScope: ["storage"],
        notes: "Mass destruction; nothing is retained.",
      },
    },
  },
];

function currentTools() {
  return adminEnabled ? [...baseTools, ...adminTools] : baseTools;
}

// ---------- tool handlers ----------

function ok(text, structuredContent) {
  const result = { content: [{ type: "text", text }] };
  if (structuredContent !== undefined) result.structuredContent = structuredContent;
  return result;
}

function toolError(text) {
  return { isError: true, content: [{ type: "text", text }] };
}

const handlers = {
  list_records() {
    const all = [...records.values()];
    return ok(JSON.stringify(all), { records: all, count: all.length });
  },
  create_record(args) {
    if (typeof args.name !== "string" || args.name.length === 0) {
      return toolError("create_record: 'name' is required");
    }
    const id = `rec_${++recordSeq}`;
    const record = { id, name: args.name, createdAt: new Date().toISOString() };
    records.set(id, record);
    return ok(`record '${args.name}' created with id ${id}`, { id, name: args.name });
  },
  delete_record(args) {
    if (typeof args.id !== "string" || !records.has(args.id)) {
      return toolError(`delete_record: unknown id '${args.id}'`);
    }
    records.delete(args.id);
    return ok(`record ${args.id} deleted`, { id: args.id, deleted: true });
  },
  send_email(args) {
    sentEmails.push({ to: args.to, subject: args.subject });
    return ok(`email sent to ${args.to}`, { to: args.to, delivered: true });
  },
  charge_payment(args) {
    if (typeof args.amount !== "number" || args.amount <= 0) {
      return toolError("charge_payment: 'amount' must be > 0");
    }
    if (args.amount > 100) {
      return toolError(
        `charge_payment: declined — amount ${args.amount} exceeds the demo card limit of 100`,
      );
    }
    const paymentId = `pay_${payments.length + 1}`;
    payments.push({ paymentId, ...args });
    return ok(`payment ${paymentId} of ${args.amount} confirmed`, {
      paymentId,
      amount: args.amount,
    });
  },
  enable_admin_tools() {
    const changed = !adminEnabled;
    adminEnabled = true;
    if (changed) notifyToolsChanged();
    return ok("admin tools enabled", { adminEnabled: true });
  },
  disable_admin_tools() {
    const changed = adminEnabled;
    adminEnabled = false;
    if (changed) notifyToolsChanged();
    return ok("admin tools disabled", { adminEnabled: false });
  },
  wipe_all_records() {
    if (!adminEnabled) return toolError("wipe_all_records: admin tools are disabled");
    const n = records.size;
    records.clear();
    return ok(`${n} record(s) permanently deleted`, { wiped: n });
  },
};

// ---------- MCP protocol (NDJSON over stdio) ----------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function notifyToolsChanged() {
  send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function onMessage(msg) {
  if (!msg || msg.jsonrpc !== "2.0") return;

  if (msg.method === "initialize") {
    respond(msg.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: true },
        // extension negotiation (SEP-2133): announce support; settings with version
        extensions: { [COMPENSATE_KEY]: { version: "0.1" } },
      },
      serverInfo: { name: "chronomcp-demo-server", version: "0.1.0" },
    });
    return;
  }
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "ping") {
    respond(msg.id, {});
    return;
  }
  // Stateless era (spec 2026-07-28 / SEP-2575): no initialize handshake —
  // server/discover exposes info, capabilities and tools in a single call.
  // This server is dual-era: no handler depends on session state.
  if (msg.method === "server/discover") {
    respond(msg.id, {
      serverInfo: { name: "chronomcp-demo-server", version: "0.1.0" },
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: true },
        extensions: { [COMPENSATE_KEY]: { version: "0.1" } },
      },
      tools: currentTools(),
    });
    return;
  }
  if (msg.method === "tools/list") {
    respond(msg.id, { tools: currentTools() });
    return;
  }
  if (msg.method === "tools/call") {
    const name = msg.params?.name;
    const args = msg.params?.arguments ?? {};
    const handler = handlers[name];
    if (!handler || (name === "wipe_all_records" && !adminEnabled)) {
      respond(msg.id, toolError(`unknown tool: ${name}`));
      return;
    }
    respond(msg.id, handler(args));
    return;
  }
  if (msg.id !== undefined && msg.method) {
    respondError(msg.id, -32601, `unsupported method: ${msg.method}`);
  }
}

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      onMessage(JSON.parse(line));
    } catch {
      // malformed line: ignore, never write garbage to stdout
    }
  }
});
process.stdin.on("end", () => process.exit(0));

process.stderr.write("chronomcp-demo-server ready (stdio)\n");
