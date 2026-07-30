// Control plane client: registers the intent and polls for the
// human decision. Zero dependencies: Node >=18 global fetch.
// Offline fallback: the caller decides (local policy) — this module
// only reports "offline" when the control plane is unreachable.
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { ActionClass, JsonValue, ToolInfo } from "./types.js";

export interface RemoteOptions {
  url: string;
  apiKey: string;
  /** Total deadline waiting for the human decision. */
  timeoutMs: number;
  /** Interval between polls. */
  pollMs: number;
}

export type RemoteDecision = "approved" | "denied" | "timeout" | "offline";

/** Outcome of a compensated step reported to the control plane. */
export type CompensationStatus = "compensated" | "compensation_failed" | "irreversible";

/** Cap on the `output` in the result report: telemetry, not a transcript. */
const MAX_REPORT_OUTPUT_CHARS = 4000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class RemoteControlPlane {
  private readonly sessionId = randomUUID();
  private readonly agentId = `chronomcp@${hostname()}`;

  constructor(
    private readonly opts: RemoteOptions,
    private readonly serverLabel: string,
    private readonly environment: string | undefined,
  ) {}

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.opts.apiKey}`,
    };
  }

  /**
   * Registers the intent (POST /v1/transactions) and waits for APPROVED/DENIED via
   * polling. Never throws: network down → "offline"; no decision in time →
   * "timeout".
   */
  async requestDecision(
    toolName: string,
    args: Record<string, JsonValue>,
    cls: ActionClass,
    tool: ToolInfo | undefined,
  ): Promise<{ decision: RemoteDecision; transactionId: string }> {
    const transactionId = randomUUID();

    try {
      const res = await fetch(`${this.opts.url}/v1/transactions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          transactionId,
          agentId: this.agentId,
          sessionId: this.sessionId,
          serverLabel: this.serverLabel,
          environment: this.environment,
          riskClass: cls,
          steps: [
            {
              order: 1,
              toolName,
              input: args,
              reversibility: tool?.compensate?.reversibility,
              compensationTool: tool?.compensate?.compensation?.toolName,
              sideEffectScope: tool?.compensate?.sideEffectScope,
            },
          ],
        }),
      });
      if (!res.ok) return { decision: "offline", transactionId };
    } catch {
      return { decision: "offline", transactionId };
    }

    const deadline = Date.now() + this.opts.timeoutMs;
    while (Date.now() < deadline) {
      await sleep(this.opts.pollMs);
      try {
        const res = await fetch(`${this.opts.url}/v1/transactions/${transactionId}`, {
          headers: this.headers(),
        });
        if (!res.ok) continue;
        const data = (await res.json()) as { transaction?: { status?: string } };
        const status = data.transaction?.status;
        if (status === "APPROVED") return { decision: "approved", transactionId };
        if (status === "DENIED") return { decision: "denied", transactionId };
      } catch {
        return { decision: "offline", transactionId };
      }
    }
    return { decision: "timeout", transactionId };
  }

  /**
   * Closes the audit loop: reports the outcome of the approved execution
   * (POST /v1/transactions/:id/result) so the control plane marks it
   * COMMITTED (ok) or FAILED. Best-effort: NEVER throws — a network/HTTP error
   * is swallowed and the response ignored (the report must never disrupt the
   * client path; the control plane guards the state with 409 if the tx is not
   * in APPROVED/COMMITTING).
   */
  async reportResult(transactionId: string, ok: boolean, output: string): Promise<void> {
    try {
      await fetch(`${this.opts.url}/v1/transactions/${transactionId}/result`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ ok, output: output.slice(0, MAX_REPORT_OUTPUT_CHARS) }),
      });
    } catch {
      // offline/timeout: telemetry lost, client untouched
    }
  }

  /**
   * Closes the trail gap: when the saga COMPENSATES a step that was an
   * APPROVED transaction on the control plane, the compensation outcome is
   * recorded via POST /v1/transactions/:id/compensated with body
   * `{ status: "compensated" | "compensation_failed" | "irreversible",
   *    detail?: string }` (same api key/headers as --remote).
   * Best-effort: NEVER throws and never blocks the rollback or the client.
   */
  async reportCompensation(
    transactionId: string,
    status: CompensationStatus,
    detail?: string,
  ): Promise<void> {
    try {
      await fetch(`${this.opts.url}/v1/transactions/${transactionId}/compensated`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          status,
          ...(detail !== undefined
            ? { detail: detail.slice(0, MAX_REPORT_OUTPUT_CHARS) }
            : {}),
        }),
      });
    } catch {
      // offline: remote trail degraded, local rollback untouched
    }
  }
}
