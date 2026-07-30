// The guard's server-side transports. The client side is always stdio
// (NDJSON); the MCP server can be a stdio child process or a remote
// Streamable HTTP endpoint. Zero dependencies: node:child_process + global fetch.
import { ChildProcessWithoutNullStreams } from "node:child_process";
import { JsonRpcMessage } from "./types.js";

export interface TransportHandlers {
  /** A raw JSON-RPC message (JSON string) from the server. */
  onMessage(raw: string): void;
  /** The server ended (process exited / HTTP session closed). */
  onExit(code: number | null): void;
  /** A payload over the limit was discarded (OOM protection). */
  onOversized(approxBytes: number): void;
}

export interface ServerTransport {
  start(handlers: TransportHandlers): void;
  send(msg: JsonRpcMessage): void;
  /** Graceful shutdown (end of the client stream). */
  end(): void;
  /** Signal shutdown (SIGINT/SIGTERM). */
  kill(): void;
}

/** Time for the child to exit on its own before SIGKILL. */
const CHILD_EXIT_GRACE_MS = 3000;

/**
 * NDJSON splitter with OOM protection: lines over maxBytes (approx., code
 * units) are discarded whole, without dropping the session.
 */
export function makeLineSplitter(
  maxBytes: number,
  onLine: (line: string) => void,
  onOversized: (approxBytes: number) => void,
): (chunk: Buffer | string) => void {
  let buf = "";
  let discarding = false;
  return (chunk) => {
    buf += chunk.toString();
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (discarding) {
        discarding = false; // remainder of the giant line: discarded
        continue;
      }
      if (line.length > maxBytes) {
        onOversized(line.length);
        continue;
      }
      if (line.length > 0) onLine(line);
    }
    if (!discarding && buf.length > maxBytes) {
      onOversized(buf.length);
      buf = "";
      discarding = true;
    }
  };
}

// ---------------------------------------------------------------- stdio

export class StdioServerTransport implements ServerTransport {
  private handlers!: TransportHandlers;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly maxLineBytes: number,
  ) {}

  start(handlers: TransportHandlers): void {
    this.handlers = handlers;
    this.child.stdout.on(
      "data",
      makeLineSplitter(
        this.maxLineBytes,
        (line) => handlers.onMessage(line),
        (n) => handlers.onOversized(n),
      ),
    );
    this.child.stderr.on("data", (d: Buffer) => process.stderr.write(d));
    this.child.on("exit", (code) => handlers.onExit(code));
  }

  send(msg: JsonRpcMessage): void {
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  end(): void {
    try {
      this.child.stdin.end();
    } catch (err) {
      process.stderr.write(
        `! ChronoMCP: failed to close the server stdin: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    this.killAfterGrace(`server did not exit within ${CHILD_EXIT_GRACE_MS}ms — SIGKILL`);
  }

  kill(): void {
    try {
      this.child.kill("SIGTERM");
    } catch {
      /* already dead */
    }
    this.killAfterGrace("SIGKILL after shutdown grace");
  }

  private killAfterGrace(reason: string): void {
    const killer = setTimeout(() => {
      process.stderr.write(`! ChronoMCP: ${reason}\n`);
      try {
        this.child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }, CHILD_EXIT_GRACE_MS);
    this.child.on("exit", () => clearTimeout(killer));
  }
}

// ---------------------------------------------------------------- http

/**
 * Streamable HTTP client (MCP spec 2025-03-26+): each message goes in a POST;
 * the response can be direct JSON or an SSE stream with one or more messages.
 * Captures and propagates Mcp-Session-Id. Documented limitation: it does not open the
 * listening GET for server-initiated messages outside a response (v1).
 */
export class HttpServerTransport implements ServerTransport {
  private handlers!: TransportHandlers;
  private sessionId: string | undefined;
  private readonly aborter = new AbortController();
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly extraHeaders: Record<string, string>,
    private readonly maxBytes: number,
  ) {}

  start(handlers: TransportHandlers): void {
    this.handlers = handlers;
  }

  send(msg: JsonRpcMessage): void {
    void this.post(msg).catch((err: unknown) => {
      if (this.closed) return;
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`! ChronoMCP: HTTP failure to the MCP server: ${detail}\n`);
      // Requests with an id must not be left unanswered: synthesize a JSON-RPC error.
      if ("method" in msg && msg.id !== undefined) {
        this.handlers.onMessage(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32000, message: `chronomcp: upstream HTTP unavailable (${detail})` },
          }),
        );
      }
    });
  }

  private async post(msg: JsonRpcMessage): Promise<void> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        ...this.extraHeaders,
      },
      body: JSON.stringify(msg),
      signal: this.aborter.signal,
    });

    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    if (res.status === 202) return; // notification/response accepted, no body
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const ctype = res.headers.get("content-type") ?? "";
    if (ctype.includes("text/event-stream")) {
      await this.readSse(res);
      return;
    }

    const text = await res.text();
    if (!text) return;
    if (text.length > this.maxBytes) {
      this.handlers.onOversized(text.length);
      return;
    }
    const parsed = JSON.parse(text) as JsonRpcMessage | JsonRpcMessage[];
    for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
      this.handlers.onMessage(JSON.stringify(m));
    }
  }

  private async readSse(res: Response): Promise<void> {
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let dataLines: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
          continue;
        }
        if (line === "") {
          if (dataLines.length > 0) {
            const payload = dataLines.join("\n");
            dataLines = [];
            if (payload.length > this.maxBytes) this.handlers.onOversized(payload.length);
            else this.handlers.onMessage(payload);
          }
          continue;
        }
        // event:/id:/retry:/comments: ignored
      }
      if (buf.length > this.maxBytes) {
        this.handlers.onOversized(buf.length);
        buf = "";
      }
    }
  }

  end(): void {
    this.close();
  }

  kill(): void {
    this.close();
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    // Best-effort: end the session on the server (DELETE with Mcp-Session-Id).
    if (this.sessionId) {
      void fetch(this.url, {
        method: "DELETE",
        headers: { "mcp-session-id": this.sessionId, ...this.extraHeaders },
      }).catch(() => {
        /* best-effort */
      });
    }
    this.aborter.abort();
    // one tick so the DELETE goes out before exit
    setTimeout(() => this.handlers.onExit(0), 50);
  }
}
