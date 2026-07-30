import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { askApprovalSync } from "./approve.js";
import { AuditLog } from "./audit.js";
import { classify, parseToolDefinition } from "./classify.js";
import { runRollback } from "./compensate.js";
import { renderImpact } from "./diff.js";
import { findStaleJournals, SagaJournal } from "./journal.js";
import { CompensationStatus, RemoteControlPlane } from "./remote.js";
import { makeLineSplitter, ServerTransport } from "./transport.js";
import {
  ActionClass,
  Decision,
  ExecutedStep,
  GuardOptions,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonValue,
  RollbackReportItem,
  ToolInfo,
} from "./types.js";

const COMP_ID_PREFIX = "chronomcp-comp-";
/** Time between requesting shutdown and forcing exit on a signal shutdown. */
const SHUTDOWN_GRACE_MS = 2000;
/** Cap for the rollback triggered by SIGINT/SIGTERM before exiting. */
const SHUTDOWN_ROLLBACK_MAX_MS = 10000;
/** Best-effort window for the remote compensation reports during shutdown. */
const SHUTDOWN_REPORT_MAX_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface PendingCall {
  toolName: string;
  args: Record<string, JsonValue>;
  cls: ActionClass;
  tool?: ToolInfo;
  /**
   * Present ONLY when the call was approved by the remote control plane:
   * when the server response arrives, the outcome is reported to
   * POST /v1/transactions/:id/result (COMMITTED/FAILED). The local path
   * (terminal gate / local policy fallback) leaves it undefined.
   */
  transactionId?: string;
}

/**
 * Short outcome summary for the control-plane report: a JSON-RPC error becomes
 * a readable message; any other case is the serialized result (the final
 * truncation happens in RemoteControlPlane.reportResult).
 */
function summarizeOutcome(res: JsonRpcResponse): string {
  if (res.error !== undefined) {
    return `JSON-RPC error ${res.error.code}: ${res.error.message}`;
  }
  try {
    return JSON.stringify(res.result) ?? "";
  } catch {
    return "[unserializable result]";
  }
}

export class GuardProxy {
  private tools = new Map<string, ToolInfo>();
  private pendingToolsList = new Set<string | number>();
  private pendingCalls = new Map<string | number, PendingCall>();
  private compWaiters = new Map<
    string,
    (res: { ok: boolean; detail?: string }) => void
  >();
  private sagaStack: ExecutedStep[] = [];
  private compSeq = 0;
  private rollingBack = false;
  private shuttingDown = false;
  private shutdownCode = 143;
  private readonly remote: RemoteControlPlane | undefined;
  private readonly sessionId = randomUUID();
  private readonly journal: SagaJournal;

  constructor(
    private readonly transport: ServerTransport,
    private readonly opts: GuardOptions,
    private readonly audit: AuditLog,
  ) {
    this.remote = opts.remote
      ? new RemoteControlPlane(opts.remote, opts.serverLabel, opts.environment)
      : undefined;
    this.journal = new SagaJournal(dirname(opts.auditPath), this.sessionId);
  }

  start(): void {
    this.audit.write("session_start", {
      server: this.opts.serverLabel,
      mode: this.opts.mode,
      saga: this.opts.saga,
      transport: this.opts.httpUrl ? "http" : "stdio",
    });

    this.warnStaleJournals();

    process.stdin.on(
      "data",
      makeLineSplitter(
        this.opts.maxLineBytes,
        (line) => this.onClientLine(line),
        (n) => this.dropOversized(n),
      ),
    );

    this.transport.start({
      onMessage: (raw) => this.onServerRaw(raw),
      onExit: (code) => this.onTransportExit(code),
      onOversized: (n) => this.dropOversized(n),
    });

    process.stdin.on("end", () => this.transport.end());
    process.stdin.on("error", (err: Error) => {
      this.log(`! ChronoMCP: client stdin error: ${err.message}`);
      this.transport.end();
    });
  }

  private onTransportExit(code: number | null): void {
    if (this.shuttingDown) process.exit(this.shutdownCode);
    if (this.opts.saga && this.sagaStack.length > 0 && code !== 0) {
      // The server died (crash/kill) with pending steps: there is no way to
      // compensate without it. The journal stays on disk as a mandatory trace.
      this.log(
        `! ChronoMCP: server exited (code=${code ?? "signal"}) with ${this.sagaStack.length} uncompensated compensable step(s) — journal preserved.`,
      );
    } else {
      // Clean end of session: pending steps = COMMITTED, nothing to compensate.
      this.journal.finalize();
    }
    this.audit.write("session_end", { childExitCode: code ?? null });
    process.exit(code ?? 0);
  }

  /**
   * Signal shutdown (SIGINT/SIGTERM). An interruption is NOT a clean end: if there is
   * a pending saga stack, the rollback runs BEFORE exiting (gap:
   * "failure OR interruption"), with a time cap. The signal handler is synchronous;
   * the async orchestration runs in performShutdown with an absolute exit
   * fallback — nothing can hold the process indefinitely.
   */
  shutdown(signal: "SIGINT" | "SIGTERM"): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.shutdownCode = signal === "SIGINT" ? 130 : 143;
    // absolute fallback: even if rollback/transport hang, the process exits
    const t = setTimeout(
      () => process.exit(this.shutdownCode),
      SHUTDOWN_ROLLBACK_MAX_MS + SHUTDOWN_GRACE_MS + 4000,
    );
    t.unref();
    void this.performShutdown(signal);
  }

  private async performShutdown(signal: "SIGINT" | "SIGTERM"): Promise<void> {
    this.log(`ChronoMCP: ${signal} received — shutting down the MCP server…`);
    try {
      if (this.opts.saga && (this.sagaStack.length > 0 || this.rollingBack)) {
        const deadline = Date.now() + SHUTDOWN_ROLLBACK_MAX_MS;
        if (this.rollingBack) {
          // failure-path rollback already in progress: wait for it to drain
          this.log(`! ChronoMCP: ${signal} while a rollback is in progress — waiting for it to drain…`);
          while (this.rollingBack && Date.now() < deadline) await sleep(50);
        }
        if (this.sagaStack.length > 0 && !this.rollingBack) {
          this.log(
            `! ChronoMCP: interrupted with ${this.sagaStack.length} pending step(s) — compensating BEFORE exit…`,
          );
          const timedOut = "chronomcp-shutdown-timeout" as const;
          const res: Array<Promise<void>> | typeof timedOut = await Promise.race([
            this.executeRollback({ signal }),
            sleep(Math.max(deadline - Date.now(), 0)).then(() => timedOut),
          ]);
          if (res === timedOut) {
            this.log(
              `! ChronoMCP: rollback did not finish within ${SHUTDOWN_ROLLBACK_MAX_MS}ms — exiting; the journal preserves the trace of what remained.`,
            );
          } else if (res.length > 0) {
            // compensation reports to the control plane: short window, best-effort
            await Promise.race([Promise.allSettled(res), sleep(SHUTDOWN_REPORT_MAX_MS)]);
          }
        }
      }
    } catch (err) {
      this.log(
        `! ChronoMCP: shutdown rollback error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.audit.write("session_end", { reason: signal });
    this.transport.kill();
    // if the transport does not report exit, exit anyway
    const t = setTimeout(() => process.exit(this.shutdownCode), SHUTDOWN_GRACE_MS + 2000);
    t.unref();
  }

  /** Warns (stderr + audit) about unfinalized journals from previous sessions. */
  private warnStaleJournals(): void {
    for (const j of findStaleJournals(dirname(this.opts.auditPath), this.sessionId)) {
      const n = j.steps >= 0 ? String(j.steps) : "?";
      this.log(
        `! ChronoMCP: incomplete saga detected from a previous session — ${n} uncompensated compensable step(s) (${j.path}). ` +
          `Automatic recovery is not performed: review/compensate manually and delete the file to silence this warning.`,
      );
      this.audit.write("stale_saga_journal", { file: j.path, steps: j.steps });
    }
  }

  private dropOversized(size: number): void {
    this.log(
      `! ChronoMCP: payload of ~${size} bytes exceeds the ${this.opts.maxLineBytes} limit — discarded (OOM protection)`,
    );
    this.audit.write("oversized_line", { approxBytes: size, limit: this.opts.maxLineBytes });
  }

  // ---------- stream plumbing ----------

  private toClient(msg: JsonRpcMessage): void {
    process.stdout.write(JSON.stringify(msg) + "\n");
  }

  private toServer(msg: JsonRpcMessage): void {
    this.transport.send(msg);
  }

  private log(text: string): void {
    process.stderr.write(text + "\n");
  }

  // ---------- client -> server ----------

  private onClientLine(line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return; // drop malformed line, never forward garbage
    }

    if (!("method" in msg)) {
      this.toServer(msg); // client responses (e.g. to server pings) pass through
      return;
    }

    const req = msg as JsonRpcRequest;

    // tools/list (legacy era) and server/discover (stateless era 2026-07-28)
    // return tool definitions — both feed the guard's index.
    if (
      (req.method === "tools/list" || req.method === "server/discover") &&
      req.id !== undefined
    ) {
      this.pendingToolsList.add(req.id);
      this.toServer(req);
      return;
    }

    if (req.method === "tools/call") {
      this.handleToolCall(req);
      return;
    }

    this.toServer(req);
  }

  private handleToolCall(req: JsonRpcRequest): void {
    const params = (req.params ?? {}) as Record<string, JsonValue>;
    const toolName = typeof params.name === "string" ? params.name : "unknown";
    const args =
      params.arguments &&
      typeof params.arguments === "object" &&
      !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, JsonValue>)
        : {};

    const tool = this.tools.get(toolName);
    const cls = classify(tool, toolName);

    this.audit.write("tool_call_proposed", {
      tool: toolName,
      class: cls,
      args: args as JsonValue,
    });

    const impact = renderImpact({
      serverLabel: this.opts.serverLabel,
      environment: this.opts.environment,
      toolName,
      args,
      cls,
      tool,
    });

    // --remote mode: human decision via the control plane (asynchronous).
    if (this.remote && cls !== "read") {
      this.log(impact);
      this.log("ChronoMCP: waiting for the remote decision from the control plane…");
      this.finishRemote(req, toolName, args, cls, tool, impact).catch(
        (err: unknown) => {
          this.log(
            `! ChronoMCP: remote decision error — denying for safety: ${err instanceof Error ? err.message : String(err)}`,
          );
          this.audit.write("tool_call_decision", {
            tool: toolName,
            decision: "denied",
            source: "remote_error",
          });
          if (req.id !== undefined) {
            this.toClient(this.deniedResponse(req.id, toolName, cls));
          }
        },
      );
      return;
    }

    const decision = this.decide(cls, impact);
    this.audit.write("tool_call_decision", { tool: toolName, decision });

    if (decision === "denied") {
      this.log(impact);
      this.log(`× ChronoMCP: call DENIED (${toolName})`);
      if (req.id !== undefined) {
        this.toClient(this.deniedResponse(req.id, toolName, cls));
      }
      return;
    }

    if (decision === "approved") this.log(impact + "\n✓ approved, executing…");

    if (req.id !== undefined) {
      this.pendingCalls.set(req.id, { toolName, args, cls, tool });
    }
    this.toServer(req);
  }

  /**
   * Remote path: intent on the control plane + polling. Offline → local
   * policy (the guard is never blind). Timeout or error → deny for safety.
   */
  private async finishRemote(
    req: JsonRpcRequest,
    toolName: string,
    args: Record<string, JsonValue>,
    cls: ActionClass,
    tool: ToolInfo | undefined,
    impact: string,
  ): Promise<void> {
    const r = await this.remote!.requestDecision(toolName, args, cls, tool);

    let decision: Decision;
    let source: string = "remote";
    if (r.decision === "approved") {
      decision = "approved";
    } else if (r.decision === "denied") {
      decision = "denied";
    } else if (r.decision === "timeout") {
      if (this.opts.remote!.onTimeout === "local") {
        source = "local_fallback_timeout";
        this.log(
          "! ChronoMCP: remote decision did not arrive in time — applying local policy (--on-remote-timeout local).",
        );
        decision = this.decide(cls, impact);
      } else {
        decision = "denied";
        source = "remote_timeout";
        this.log("! ChronoMCP: remote decision did not arrive in time — DENYING for safety.");
      }
    } else {
      // offline: fall back to the local policy
      source = "local_fallback";
      this.log("! ChronoMCP: control plane unreachable — applying local policy.");
      decision = this.decide(cls, impact);
    }

    this.audit.write("tool_call_decision", {
      tool: toolName,
      decision,
      source,
      transactionId: r.transactionId,
    });

    if (decision === "denied") {
      this.log(`× ChronoMCP: call DENIED (${toolName}) [${source}]`);
      if (req.id !== undefined) {
        this.toClient(this.deniedResponse(req.id, toolName, cls));
      }
      return;
    }

    this.log(`✓ approved [${source}], executing…`);
    if (req.id !== undefined) {
      const pending: PendingCall = { toolName, args, cls, tool };
      // Only a genuinely REMOTE approval closes the loop with /result: in the
      // fallbacks (offline/timeout→local) the tx is not APPROVED on the control
      // plane, and the endpoint would reject the report with 409.
      if (r.decision === "approved") pending.transactionId = r.transactionId;
      this.pendingCalls.set(req.id, pending);
    }
    this.toServer(req);
  }

  private decide(cls: ActionClass, impact: string): Decision {
    if (cls === "read") return "auto";

    if (this.opts.mode === "log") {
      this.log(impact);
      return "auto";
    }

    if (this.opts.mode === "block") {
      return cls === "destructive" ? "denied" : "auto";
    }

    // gate mode
    const answer = askApprovalSync(impact);
    if (answer === null) {
      this.log(
        `! ChronoMCP: no TTY for approval — onNoTty policy=${this.opts.onNoTty}`,
      );
      return this.opts.onNoTty === "allow" ? "auto" : "denied";
    }
    return answer ? "approved" : "denied";
  }

  private deniedResponse(
    id: string | number,
    toolName: string,
    cls: ActionClass,
  ): JsonRpcResponse {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text:
              `ChronoMCP guard: the call '${toolName}' (${cls}) was blocked by the ` +
              `'${this.opts.mode}' policy. No mutation occurred. Request human approval or use a read-only action.`,
          },
        ],
      } as unknown as JsonValue,
    };
  }

  // ---------- server -> client ----------

  private onServerRaw(raw: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(raw) as JsonRpcMessage;
    } catch {
      return;
    }

    if ("method" in msg) {
      this.toClient(msg); // server-initiated requests/notifications pass through
      return;
    }

    const res = msg as JsonRpcResponse;

    // Responses to our synthetic compensation calls: consume, never leak to client.
    if (typeof res.id === "string" && res.id.startsWith(COMP_ID_PREFIX)) {
      const waiter = this.compWaiters.get(res.id);
      if (waiter) {
        this.compWaiters.delete(res.id);
        const failed =
          res.error !== undefined ||
          (res.result &&
            typeof res.result === "object" &&
            !Array.isArray(res.result) &&
            (res.result as Record<string, JsonValue>).isError === true);
        waiter({
          ok: !failed,
          detail: res.error ? res.error.message : undefined,
        });
      }
      return;
    }

    if (res.id !== null && this.pendingToolsList.has(res.id)) {
      this.pendingToolsList.delete(res.id);
      this.indexTools(res);
      this.toClient(res);
      return;
    }

    if (res.id !== null && this.pendingCalls.has(res.id)) {
      const call = this.pendingCalls.get(res.id)!;
      this.pendingCalls.delete(res.id);
      // Never swallow a post-processing failure: log it and ensure the
      // response reaches the client (toClient is always the LAST action on the
      // happy path, so there is no risk of a duplicate send).
      this.afterToolResult(call, res).catch((err: unknown) => {
        this.log(
          `! ChronoMCP: post-processing error for '${call.toolName}': ${err instanceof Error ? err.message : String(err)}`,
        );
        this.rollingBack = false;
        try {
          this.toClient(res);
        } catch {
          /* stdout closed — nothing to do */
        }
      });
      return;
    }

    this.toClient(res);
  }

  private indexTools(res: JsonRpcResponse): void {
    const result = res.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) return;
    // tools/list and server/discover expose `tools` in the result (re-verify the
    // final shape of server/discover against the published spec 2026-07-28).
    const list = (result as Record<string, JsonValue>).tools;
    if (!Array.isArray(list)) return;
    for (const raw of list) {
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const info = parseToolDefinition(raw as Record<string, JsonValue>);
        this.tools.set(info.name, info);
      }
    }
    this.log(
      `ChronoMCP: ${this.tools.size} tools indexed from ${this.opts.serverLabel}`,
    );
  }

  private async afterToolResult(
    call: PendingCall,
    res: JsonRpcResponse,
  ): Promise<void> {
    const failed =
      res.error !== undefined ||
      (res.result &&
        typeof res.result === "object" &&
        !Array.isArray(res.result) &&
        (res.result as Record<string, JsonValue>).isError === true);

    this.audit.write("tool_call_result", {
      tool: call.toolName,
      ok: !failed,
    });

    // Close the audit loop on the control plane (COMMITTED/FAILED) for
    // remotely approved calls. Fire-and-forget: best-effort telemetry
    // that NEVER delays or alters the response going to the client.
    if (call.transactionId !== undefined && this.remote) {
      void this.remote
        .reportResult(call.transactionId, !failed, summarizeOutcome(res))
        .catch((err: unknown) => {
          this.log(
            `! ChronoMCP: result report to the control plane failed (ignored): ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }

    if (!failed) {
      if (this.opts.saga && call.cls !== "read") {
        this.sagaStack.push({
          callId: res.id ?? "n/a",
          toolName: call.toolName,
          input: call.args,
          output: res.result,
          compensate: call.tool?.compensate,
          // link to the approved remote tx: this step's compensation
          // will be reported to /compensated (closes the control-plane trail)
          ...(call.transactionId !== undefined
            ? { transactionId: call.transactionId }
            : {}),
        });
        // durable journal: a CRASH from here on leaves a recoverable trace
        this.journal.persist(this.sagaStack);
      }
      this.toClient(res);
      return;
    }

    // Failure path: run LIFO compensation BEFORE handing the error back,
    // so the agent sees the error only after the environment is compensated.
    if (this.opts.saga && this.sagaStack.length > 0 && !this.rollingBack) {
      this.log(
        `\n! ChronoMCP: '${call.toolName}' failed — starting rollback of ${this.sagaStack.length} step(s)…`,
      );
      // remote reports stay best-effort: they NEVER delay the response
      await this.executeRollback({ failedTool: call.toolName });
    }

    this.toClient(res);
  }

  /**
   * Executes the LIFO compensation stack — triggered by a tool failure OR by
   * an interruption (SIGINT/SIGTERM). Audits each step, keeps the durable journal
   * up to date, and reports to the control plane each step born from a remote
   * approval. Returns the remote report promises (best-effort) for anyone who
   * wants to await them with a cap (shutdown); never throws.
   */
  private async executeRollback(reason: {
    failedTool?: string;
    signal?: string;
  }): Promise<Array<Promise<void>>> {
    this.rollingBack = true;
    this.audit.write("rollback_started", {
      stackSize: this.sagaStack.length,
      ...(reason.failedTool !== undefined ? { failedTool: reason.failedTool } : {}),
      ...(reason.signal !== undefined ? { reason: reason.signal } : {}),
    });

    const report = await runRollback(this.sagaStack, (tool, args, timeoutMs) => {
      // snapshot on each compensation: a crash mid-rollback preserves the rest
      this.journal.persist(this.sagaStack);
      return this.invokeCompensation(tool, args, timeoutMs);
    });

    const remoteReports: Array<Promise<void>> = [];
    for (const item of report) {
      this.audit.write("rollback_step", item as unknown as Record<string, JsonValue>);
      const mark =
        item.status === "compensated"
          ? "✓"
          : item.status === "irreversible"
            ? "≠"
            : "×";
      this.log(
        `  ${mark} ${item.toolName}: ${item.status}${item.detail ? ` (${item.detail})` : ""}`,
      );
      const p = this.reportCompensationRemote(item);
      if (p) remoteReports.push(p);
    }
    const irreversible = report.filter(
      (r) => r.status === "irreversible" || r.status === "no_compensation",
    );
    if (irreversible.length > 0) {
      this.log(
        `! WARNING: ${irreversible.length} action(s) with NO possible reversal — review manually.`,
      );
    }
    this.audit.write("rollback_finished", {
      compensated: report.filter((r) => r.status === "compensated").length,
      irreversible: irreversible.length,
    });
    if (this.sagaStack.length === 0) this.journal.finalize();
    else this.journal.persist(this.sagaStack);
    this.rollingBack = false;
    return remoteReports;
  }

  /**
   * Closes the control-plane trail for a compensated step born from a
   * remote approval (POST /v1/transactions/:id/compensated). Steps with no
   * transactionId (local/fallback approval) do not report. Mapping:
   * compensated → "compensated"; compensation_failed → "compensation_failed";
   * irreversible AND no_compensation → "irreversible" (nothing was undone — and
   * no_compensation gets an explicit detail of unknown reversibility).
   * Fire-and-forget: never throws, never blocks.
   */
  private reportCompensationRemote(item: RollbackReportItem): Promise<void> | undefined {
    if (item.transactionId === undefined || !this.remote) return undefined;
    const status: CompensationStatus =
      item.status === "compensated"
        ? "compensated"
        : item.status === "compensation_failed"
          ? "compensation_failed"
          : "irreversible";
    const detail =
      item.status === "no_compensation"
        ? "no mcp-compensate — reversibility unknown, nothing was undone"
        : item.detail;
    return this.remote
      .reportCompensation(item.transactionId, status, detail)
      .catch((err: unknown) => {
        this.log(
          `! ChronoMCP: compensation report to the control plane failed (ignored): ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  private invokeCompensation(
    toolName: string,
    args: Record<string, JsonValue>,
    timeoutMs: number,
  ): Promise<{ ok: boolean; detail?: string }> {
    const id = `${COMP_ID_PREFIX}${++this.compSeq}`;
    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    };

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.compWaiters.delete(id);
        resolve({ ok: false, detail: `timeout ${timeoutMs}ms` });
      }, timeoutMs);

      this.compWaiters.set(id, (res) => {
        clearTimeout(timer);
        resolve(res);
      });

      this.toServer(req);
    });
  }
}
