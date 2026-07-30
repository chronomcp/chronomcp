import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, parseToolDefinition } from "../dist/classify.js";

const META_KEY = "dev.chronomcp/compensate";

test("cascade: mcp-compensate beats annotations and name", () => {
  const tool = parseToolDefinition({
    name: "delete_everything", // name says destructive…
    annotations: { readOnlyHint: true }, // annotation says read…
    _meta: { [META_KEY]: { reversibility: "compensable" } }, // extension wins: mutating
  });
  assert.equal(classify(tool, tool.name), "mutating");
});

test("mcp-compensate: readonly → read, irreversible → destructive", () => {
  const ro = parseToolDefinition({ name: "x", _meta: { [META_KEY]: { reversibility: "readonly" } } });
  const irr = parseToolDefinition({ name: "x", _meta: { [META_KEY]: { reversibility: "irreversible" } } });
  assert.equal(classify(ro, "x"), "read");
  assert.equal(classify(irr, "x"), "destructive");
});

test("native MCP annotations beat the name heuristic", () => {
  const tool = parseToolDefinition({
    name: "delete_file",
    annotations: { readOnlyHint: true },
  });
  assert.equal(classify(tool, "delete_file"), "read");
});

test("annotations: destructiveHint and readOnlyHint=false", () => {
  const destr = parseToolDefinition({ name: "x", annotations: { destructiveHint: true } });
  const mut = parseToolDefinition({ name: "x", annotations: { readOnlyHint: false } });
  assert.equal(classify(destr, "x"), "destructive");
  assert.equal(classify(mut, "x"), "mutating");
});

test("name heuristic: destructive, mutating and read allowlist", () => {
  assert.equal(classify(undefined, "delete_user"), "destructive");
  assert.equal(classify(undefined, "drop_table"), "destructive");
  assert.equal(classify(undefined, "create_invoice"), "mutating");
  assert.equal(classify(undefined, "send_message"), "mutating");
  // read only when the verb is EXPLICITLY a read verb (allowlist)
  assert.equal(classify(undefined, "get_weather"), "read");
  assert.equal(classify(undefined, "search_docs"), "read");
});

test("CONSERVATIVE fallback: a name with no recognized verb → mutating (never read)", () => {
  // UNKNOWN reversibility is never inferred as safe: a tool with no
  // annotations, no mcp-compensate and no verb in the vocabulary requires approval
  assert.equal(classify(undefined, "sequentialthinking"), "mutating");
  assert.equal(classify(undefined, "foo_bar"), "mutating");
  assert.equal(classify(undefined, "processar_nota"), "mutating");
  assert.equal(classify(undefined, "zap"), "mutating");
});

test("pt/es verbs reinforce the heuristic (non-English names don't slip through)", () => {
  assert.equal(classify(undefined, "criar_usuario"), "mutating");
  assert.equal(classify(undefined, "disparar_cobranca"), "mutating");
  assert.equal(classify(undefined, "enviar_fatura"), "mutating");
  assert.equal(classify(undefined, "cobrar_cliente"), "mutating");
  assert.equal(classify(undefined, "pagar_boleto"), "mutating");
  assert.equal(classify(undefined, "apagar_registro"), "destructive");
  assert.equal(classify(undefined, "excluir_conta"), "destructive");
  assert.equal(classify(undefined, "remover_item"), "destructive");
  // and pt read verbs also enter the allowlist
  assert.equal(classify(undefined, "listar_pedidos"), "read");
  assert.equal(classify(undefined, "consultar_saldo"), "read");
});

test("a mutating verb beats a read verb in the same name (get_or_create)", () => {
  assert.equal(classify(undefined, "get_or_create_user"), "mutating");
  assert.equal(classify(undefined, "find_and_delete"), "destructive");
});

test("the name heuristic covers snake_case, camelCase and kebab-case", () => {
  // regression: `_` is a word char — `\bwrite\b` does not match "write_file" without normalization
  assert.equal(classify(undefined, "write_file"), "mutating");
  assert.equal(classify(undefined, "createDirectory"), "mutating");
  assert.equal(classify(undefined, "force-remove"), "destructive");
  assert.equal(classify(undefined, "userDelete"), "destructive");
  assert.equal(classify(undefined, "files.upload"), "mutating");
  assert.equal(classify(undefined, "read_text_file"), "read");
});

test("parseToolDefinition extracts the compensate block from _meta", () => {
  const tool = parseToolDefinition({
    name: "create_record",
    description: "cria",
    _meta: {
      [META_KEY]: {
        reversibility: "compensable",
        compensation: { toolName: "delete_record", parameterMapping: { id: "$.output.structuredContent.id" } },
      },
    },
  });
  assert.equal(tool.compensate?.reversibility, "compensable");
  assert.equal(tool.compensate?.compensation?.toolName, "delete_record");
});
