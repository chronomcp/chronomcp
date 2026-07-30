// ChronoMCP core types — zero-dependency.

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, JsonValue>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: JsonValue;
  error?: { code: number; message: string; data?: JsonValue };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse;

// ---- MCP tool metadata (subset we care about) ----

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export type Reversibility = "readonly" | "compensable" | "irreversible";

export interface CompensationSpec {
  toolName: string;
  /** e.g. { "username": "$.input.username" } — static JSONPath-lite only. */
  parameterMapping: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface CompensateMeta {
  reversibility: Reversibility;
  compensation?: CompensationSpec;
  sideEffectScope?: string[];
  notes?: string;
}

// Extension identifier in the SEP-2133 format (MCP spec 2026-07-28):
// {reverse vendor-prefix}/{name}. The version evolves INSIDE the settings object;
// a -v2 name suffix only on a breaking change.
export const COMPENSATE_META_KEY = "dev.chronomcp/compensate";

export interface ToolInfo {
  name: string;
  description?: string;
  annotations?: ToolAnnotations;
  compensate?: CompensateMeta;
}

// ---- Classification & policy ----

export type ActionClass = "read" | "mutating" | "destructive";

export type PolicyMode = "log" | "gate" | "block";

export interface GuardOptions {
  mode: PolicyMode;
  saga: boolean;
  /** What to do in gate mode when no TTY is available. */
  onNoTty: "allow" | "deny";
  auditPath: string;
  serverLabel: string;
  /**
   * Environment the guarded MCP server touches (e.g. "production", "staging",
   * "homolog"). Shown prominently in the impact diff and travels in the intent to the
   * control plane — so the human KNOWS where the action lands before
   * approving. Free-form; any value containing "prod" is treated as PRODUCTION (alert).
   */
  environment?: string;
  /** OOM guard: NDJSON lines above this are discarded (approx., code units). */
  maxLineBytes: number;
  /** Remote MCP server via Streamable HTTP (instead of a stdio child). */
  httpUrl?: string;
  /** Extra headers for the HTTP transport (e.g. Authorization). */
  httpHeaders: Record<string, string>;
  /** Remote control plane: human approval outside the terminal. */
  remote?: {
    url: string;
    apiKey: string;
    timeoutMs: number;
    pollMs: number;
    /** Action when the deadline passes with no decision: deny (default) or local policy. */
    onTimeout: "deny" | "local";
  };
}

export type Decision = "approved" | "denied" | "auto";

// ---- Saga runtime ----

export interface ExecutedStep {
  callId: string | number;
  toolName: string;
  input: Record<string, JsonValue>;
  output?: JsonValue;
  compensate?: CompensateMeta;
  /**
   * Control-plane transaction id when this step was born from a
   * genuine REMOTE approval. Present → this step's compensation is
   * reported via POST /v1/transactions/:id/compensated (best-effort).
   */
  transactionId?: string;
}

export interface RollbackReportItem {
  toolName: string;
  status: "compensated" | "compensation_failed" | "irreversible" | "no_compensation";
  detail?: string;
  /** Propagated from ExecutedStep: closes the trail of the compensated remote tx. */
  transactionId?: string;
}

// ---- Audit ----

export interface AuditEntry {
  ts: string;
  event:
    | "session_start"
    | "tool_call_proposed"
    | "tool_call_decision"
    | "tool_call_result"
    | "rollback_started"
    | "rollback_step"
    | "rollback_finished"
    | "oversized_line"
    | "stale_saga_journal"
    | "session_end";
  data: Record<string, JsonValue>;
  prevHash: string;
  hash?: string;
}
