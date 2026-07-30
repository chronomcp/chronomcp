import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveMapping, buildCompensationArgs, runRollback } from "../dist/compensate.js";

const step = (over = {}) => ({
  callId: 1,
  toolName: "create_record",
  input: { name: "pedido", nested: { deep: "v" } },
  output: { structuredContent: { id: "rec_1" }, content: [{ type: "text", text: "ok" }] },
  ...over,
});

test("resolveMapping: valid paths in input and output", () => {
  assert.equal(resolveMapping("$.input.name", step()), "pedido");
  assert.equal(resolveMapping("$.input.nested.deep", step()), "v");
  assert.equal(resolveMapping("$.output.structuredContent.id", step()), "rec_1");
});

test("resolveMapping: rejects paths outside the static JSONPath-lite", () => {
  assert.equal(resolveMapping("$.output.content.0.text", step()), undefined); // array index: forbidden
  assert.equal(resolveMapping("$.input", step()), undefined); // bare root
  assert.equal(resolveMapping("$.env.SECRET", step()), undefined); // unknown root
  assert.equal(resolveMapping("input.name", step()), undefined); // no $.
  assert.equal(resolveMapping("$.input.missing.x", step()), undefined); // nonexistent path
});

test("buildCompensationArgs: maps, flags irreversible and none", () => {
  const compensable = step({
    compensate: {
      reversibility: "compensable",
      compensation: { toolName: "delete_record", parameterMapping: { id: "$.output.structuredContent.id" } },
    },
  });
  assert.deepEqual(buildCompensationArgs(compensable), {
    toolName: "delete_record",
    args: { id: "rec_1" },
  });

  const irr = step({ compensate: { reversibility: "irreversible" } });
  assert.deepEqual(buildCompensationArgs(irr), { irreversible: true });

  assert.deepEqual(buildCompensationArgs(step()), { none: true }); // no metadata
});

test("runRollback: LIFO order and honest report", async () => {
  const calls = [];
  const stack = [
    step({
      toolName: "first_created",
      compensate: {
        reversibility: "compensable",
        compensation: { toolName: "undo_first", parameterMapping: { id: "$.output.structuredContent.id" } },
      },
    }),
    step({ toolName: "email_sent", compensate: { reversibility: "irreversible", notes: "sem volta" } }),
    step({ toolName: "unknown_tool" }), // sem mcp-compensate
    step({
      toolName: "last_created",
      compensate: {
        reversibility: "compensable",
        compensation: { toolName: "undo_last", parameterMapping: { id: "$.output.structuredContent.id" } },
      },
    }),
  ];

  const report = await runRollback(stack, async (toolName, args) => {
    calls.push(toolName);
    return { ok: true };
  });

  // LIFO: the last executed step is the first compensated
  assert.deepEqual(calls, ["undo_last", "undo_first"]);
  assert.deepEqual(
    report.map((r) => [r.toolName, r.status]),
    [
      ["last_created", "compensated"],
      ["unknown_tool", "no_compensation"],
      ["email_sent", "irreversible"],
      ["first_created", "compensated"],
    ],
  );
});

test("runRollback: retry up to maxRetries and then compensation_failed", async () => {
  let attempts = 0;
  const stack = [
    step({
      compensate: {
        reversibility: "compensable",
        compensation: {
          toolName: "undo",
          parameterMapping: {},
          maxRetries: 2,
        },
      },
    }),
  ];
  const report = await runRollback(stack, async () => {
    attempts++;
    return { ok: false, detail: "boom" };
  });
  assert.equal(attempts, 3); // 1 tentativa + 2 retries
  assert.equal(report[0].status, "compensation_failed");
  assert.equal(report[0].detail, "boom");
});
