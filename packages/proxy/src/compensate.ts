import {
  ExecutedStep,
  JsonValue,
  RollbackReportItem,
} from "./types.js";

/**
 * Resolve a JSONPath-lite reference ("$.input.x.y" | "$.output.x") against the
 * original call. Static paths only — no LLM, no expressions. Deterministic by design.
 */
export function resolveMapping(
  path: string,
  step: ExecutedStep,
): JsonValue | undefined {
  const m = /^\$\.(input|output)((?:\.[A-Za-z_][A-Za-z0-9_]*)+)$/.exec(path);
  if (!m) return undefined;
  const rootName = m[1] as "input" | "output";
  const segs = m[2]!.split(".").filter(Boolean);
  let cur: JsonValue | undefined =
    rootName === "input" ? (step.input as JsonValue) : step.output;
  for (const s of segs) {
    if (cur && typeof cur === "object" && !Array.isArray(cur)) {
      cur = (cur as Record<string, JsonValue>)[s];
    } else {
      return undefined;
    }
  }
  return cur;
}

export function buildCompensationArgs(
  step: ExecutedStep,
): { toolName: string; args: Record<string, JsonValue> } | { irreversible: true } | { none: true } {
  const meta = step.compensate;
  if (!meta) return { none: true };
  if (meta.reversibility === "irreversible") return { irreversible: true };
  if (meta.reversibility !== "compensable" || !meta.compensation) return { none: true };

  const args: Record<string, JsonValue> = {};
  for (const [param, ref] of Object.entries(meta.compensation.parameterMapping)) {
    const v = resolveMapping(ref, step);
    if (v !== undefined) args[param] = v;
  }
  return { toolName: meta.compensation.toolName, args };
}

export type InvokeTool = (
  toolName: string,
  args: Record<string, JsonValue>,
  timeoutMs: number,
) => Promise<{ ok: boolean; detail?: string }>;

/**
 * Execute the LIFO compensation stack. Never throws: always returns a full,
 * honest report — including what could NOT be undone.
 */
export async function runRollback(
  stack: ExecutedStep[],
  invoke: InvokeTool,
): Promise<RollbackReportItem[]> {
  const report: RollbackReportItem[] = [];

  while (stack.length > 0) {
    const step = stack.pop()!;
    const plan = buildCompensationArgs(step);
    // Propagate the link to the approved remote tx (when present) so the
    // caller can close the control-plane trail per compensated step.
    const txRef =
      step.transactionId !== undefined ? { transactionId: step.transactionId } : {};

    if ("irreversible" in plan) {
      report.push({
        toolName: step.toolName,
        status: "irreversible",
        detail: step.compensate?.notes,
        ...txRef,
      });
      continue;
    }
    if ("none" in plan) {
      report.push({ toolName: step.toolName, status: "no_compensation", ...txRef });
      continue;
    }

    const timeoutMs = step.compensate?.compensation?.timeoutMs ?? 5000;
    const maxRetries = step.compensate?.compensation?.maxRetries ?? 3;

    let done = false;
    let lastDetail: string | undefined;
    for (let attempt = 0; attempt <= maxRetries && !done; attempt++) {
      const res = await invoke(plan.toolName, plan.args, timeoutMs);
      done = res.ok;
      lastDetail = res.detail;
    }

    report.push({
      toolName: step.toolName,
      status: done ? "compensated" : "compensation_failed",
      detail: done ? `via ${plan.toolName}` : lastDetail,
      ...txRef,
    });
  }

  return report;
}
