import {
  ActionClass,
  CompensateMeta,
  COMPENSATE_META_KEY,
  JsonValue,
  ToolInfo,
} from "./types.js";

// Verbs in en + pt + es. The extra languages REINFORCE the heuristic; the real
// defense against names outside the vocabulary is the conservative fallback (mutating).
const DESTRUCTIVE_RE =
  /\b(delete|remove|drop|destroy|terminate|revoke|purge|truncate|erase|wipe|cancel|apagar|excluir|deletar|remover|destruir|cancelar|eliminar|borrar|limpar)\b/;

const MUTATING_RE =
  /\b(create|update|write|insert|send|post|put|patch|set|add|move|rename|deploy|execute|run|pay|transfer|charge|refund|approve|merge|push|upload|publish|schedule|invite|assign|grant|criar|crear|atualizar|actualizar|gravar|escrever|escribir|salvar|guardar|enviar|mandar|disparar|cobrar|pagar|transferir|estornar|publicar|agendar|alterar|modificar|inserir|adicionar|mover|renomear|executar|aprovar)\b/;

/**
 * EXPLICIT allowlist of read verbs. Only names with one of these verbs are
 * auto-approved by the heuristic; any name outside the vocabulary falls into the
 * conservative fallback (mutating) — UNKNOWN reversibility is never
 * inferred as safe.
 */
const READ_RE =
  /\b(get|list|read|search|find|fetch|query|show|describe|view|inspect|count|check|status|stat|echo|ping|browse|preview|listar|buscar|consultar|ler|ver|mostrar|obter|exibir|pesquisar|procurar)\b/;

/**
 * `_` counts as a word character in regex, so `\bcreate\b` does NOT match
 * "create_invoice". Normalizes snake_case, kebab-case, dots and camelCase
 * to spaces before matching — otherwise the heuristic fails precisely on the
 * dominant MCP tool-naming convention.
 */
function normalizeToolName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-./]+/g, " ")
    .toLowerCase();
}

/**
 * Build a ToolInfo registry entry from a raw MCP tool definition
 * (as returned inside a tools/list result).
 */
export function parseToolDefinition(raw: Record<string, JsonValue>): ToolInfo {
  const name = typeof raw.name === "string" ? raw.name : "unknown";
  const description =
    typeof raw.description === "string" ? raw.description : undefined;

  const annotations =
    raw.annotations && typeof raw.annotations === "object" && !Array.isArray(raw.annotations)
      ? (raw.annotations as ToolInfo["annotations"])
      : undefined;

  let compensate: CompensateMeta | undefined;
  const meta = raw._meta;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    const block = (meta as Record<string, JsonValue>)[COMPENSATE_META_KEY];
    if (block && typeof block === "object" && !Array.isArray(block)) {
      compensate = block as unknown as CompensateMeta;
    }
  }

  return { name, description, annotations, compensate };
}

/**
 * Classify a tool call. Priority:
 * 1. mcp-compensate extension metadata (explicit reversibility)
 * 2. Native MCP annotations (readOnlyHint / destructiveHint)
 * 3. Name heuristics — destructive > mutating > read allowlist; a name with no
 *    recognized verb = UNKNOWN → mutating (requires approval). Never
 *    infer "safe" from ignorance.
 */
export function classify(tool: ToolInfo | undefined, toolName: string): ActionClass {
  if (tool?.compensate) {
    if (tool.compensate.reversibility === "readonly") return "read";
    if (tool.compensate.reversibility === "irreversible") return "destructive";
    return "mutating"; // compensable
  }

  if (tool?.annotations) {
    if (tool.annotations.readOnlyHint === true) return "read";
    if (tool.annotations.destructiveHint === true) return "destructive";
    if (tool.annotations.readOnlyHint === false) return "mutating";
  }

  const normalized = normalizeToolName(toolName);
  if (DESTRUCTIVE_RE.test(normalized)) return "destructive";
  if (MUTATING_RE.test(normalized)) return "mutating";
  if (READ_RE.test(normalized)) return "read";
  // CONSERVATIVE fallback: with no annotations, no mcp-compensate and no verb
  // recognized in the name (e.g. "disparar_cobranca" in a language outside the
  // vocabulary), the action is treated as mutating — it goes through the gate instead of
  // being auto-approved. A false positive costs one click; a false negative costs
  // a mutation without approval.
  return "mutating";
}
