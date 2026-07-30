#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AuditLog, verifyChain } from "./audit.js";
import { GuardProxy } from "./proxy.js";
import {
  HttpServerTransport,
  ServerTransport,
  StdioServerTransport,
} from "./transport.js";
import { AuditEntry, GuardOptions, PolicyMode } from "./types.js";

const HELP = `
chronomcp — transactional guard proxy for MCP servers

Usage:
  chronomcp guard [options] -- <MCP server command...>       (stdio server)
  chronomcp guard [options] --http <url>                      (Streamable HTTP server)
  chronomcp verify [audit-file]                              (verify the audit log hash chain;
                                                              default: ~/.chronomcp/audit.jsonl; exit 0 = intact)

Options:
  --mode <log|gate|block>   log: audit only | gate: ask for human approval | block: deny destructive (default: gate)
  --saga                    enable the compensation stack (LIFO rollback via mcp-compensate)
  --on-no-tty <allow|deny>  policy when there is no terminal to approve in gate mode (default: deny)
  --label <name>            server label in logs (default: command or url)
  --env <name>              environment touched: production|staging|homolog|dev (or env CHRONOMCP_ENV).
                            Shown PROMINENTLY in the impact diff and the control plane; "prod" => alert.
  --audit <file>            audit log path (default: ~/.chronomcp/audit.jsonl)
  --max-line-bytes <n>      per-payload NDJSON/HTTP limit, OOM protection (default: 16777216 = 16MiB)
  --http <url>              guard a remote MCP server via Streamable HTTP (no '--' needed)
  --header "Name: value"    extra header for the HTTP transport (repeatable; e.g. Authorization)
  --remote <url>            control plane for remote approval. Offline → local policy
  --remote-key <key>        control plane API key (or env CHRONOMCP_REMOTE_KEY)
  --remote-timeout-ms <n>   deadline waiting for the remote decision (default: 60000)
  --on-remote-timeout <deny|local>  action on timeout: deny (default) or apply the local policy (--mode)
  --remote-poll-ms <n>      decision polling interval (default: 1500)

Examples:
  chronomcp guard --mode gate --saga -- npx -y @modelcontextprotocol/server-filesystem /tmp
  chronomcp guard --mode gate --http https://mcp.example.com/mcp --header "Authorization: Bearer TOKEN"
`;

function fail(msg: string): never {
  process.stderr.write(msg + "\n" + HELP);
  process.exit(1);
}

/**
 * `chronomcp verify [file]`: recomputes the audit log's SHA-256 chain with the
 * SAME logic as AuditLog (verifyChain) and reports integrity. Human output is
 * ALWAYS on stderr — the binary's stdout stays reserved for guard-mode JSON-RPC
 * (inviolable rule #1), and keeping verify out of it avoids any
 * risk of mixing in pipelines. Exit 0 = intact; 1 = tampered/unreadable.
 * The "#K" numbering is 1-based (K = line of the JSONL file).
 */
function runVerify(args: string[]): never {
  const file = args[0] ?? join(homedir(), ".chronomcp", "audit.jsonl");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    process.stderr.write(
      `chronomcp verify: could not read '${file}': ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const entries: AuditEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      entries.push(JSON.parse(lines[i]!) as AuditEntry);
    } catch {
      process.stderr.write(
        `TAMPERING detected at entry #${i + 1} of '${file}' (line is not valid JSON)\n`,
      );
      process.exit(1);
    }
  }

  const check = verifyChain(entries);
  if (check.ok) {
    process.stderr.write(`chain intact: ${check.entries} entry(ies) in '${file}'\n`);
    process.exit(0);
  }
  process.stderr.write(
    `TAMPERING detected at entry #${check.brokenAt + 1} of '${file}' ` +
      `(${check.reason === "hash" ? "hash mismatch" : "prev_hash broken"})\n`,
  );
  process.exit(1);
}

function parseArgs(argv: string[]): { opts: GuardOptions; cmd: string[] } {
  if (argv[0] !== "guard") fail("Unknown command. Use: chronomcp guard … | chronomcp verify …");

  const sep = argv.indexOf("--");
  const flags = sep < 0 ? argv.slice(1) : argv.slice(1, sep);
  const cmd = sep < 0 ? [] : argv.slice(sep + 1);

  const opts: GuardOptions = {
    mode: "gate",
    saga: false,
    onNoTty: "deny",
    auditPath: join(homedir(), ".chronomcp", "audit.jsonl"),
    serverLabel: "",
    maxLineBytes: 16 * 1024 * 1024,
    httpHeaders: {},
    environment: process.env.CHRONOMCP_ENV || undefined,
  };
  let remoteUrl: string | undefined;
  let remoteKey: string | undefined = process.env.CHRONOMCP_REMOTE_KEY;
  let remoteTimeoutMs = 60000;
  let remotePollMs = 1500;
  let onRemoteTimeout: "deny" | "local" = "deny";

  for (let i = 0; i < flags.length; i++) {
    const f = flags[i]!;
    switch (f) {
      case "--mode": {
        const v = flags[++i];
        if (v !== "log" && v !== "gate" && v !== "block") fail(`invalid --mode: ${v}`);
        opts.mode = v as PolicyMode;
        break;
      }
      case "--saga":
        opts.saga = true;
        break;
      case "--on-no-tty": {
        const v = flags[++i];
        if (v !== "allow" && v !== "deny") fail(`invalid --on-no-tty: ${v}`);
        opts.onNoTty = v;
        break;
      }
      case "--label":
        opts.serverLabel = flags[++i] ?? opts.serverLabel;
        break;
      case "--env":
        opts.environment = flags[++i]?.trim() || opts.environment;
        break;
      case "--audit":
        opts.auditPath = flags[++i] ?? opts.auditPath;
        break;
      case "--max-line-bytes": {
        const v = Number(flags[++i]);
        if (!Number.isInteger(v) || v < 1024) fail(`invalid --max-line-bytes (minimum 1024): ${flags[i]}`);
        opts.maxLineBytes = v;
        break;
      }
      case "--http": {
        const v = flags[++i];
        if (!v || !/^https?:\/\//.test(v)) fail(`--http requires an http(s) URL: ${v}`);
        opts.httpUrl = v;
        break;
      }
      case "--header": {
        const v = flags[++i];
        const m = v ? /^([^:]+):\s*(.+)$/.exec(v) : null;
        if (!m) fail(`--header invalid (use "Name: value"): ${v}`);
        opts.httpHeaders[m[1]!.trim()] = m[2]!;
        break;
      }
      case "--remote": {
        const v = flags[++i];
        if (!v || !/^https?:\/\//.test(v)) fail(`--remote requires an http(s) URL: ${v}`);
        remoteUrl = v;
        break;
      }
      case "--remote-key":
        remoteKey = flags[++i] ?? remoteKey;
        break;
      case "--remote-timeout-ms": {
        const v = Number(flags[++i]);
        if (!Number.isInteger(v) || v < 1000) fail(`invalid --remote-timeout-ms (minimum 1000): ${flags[i]}`);
        remoteTimeoutMs = v;
        break;
      }
      case "--on-remote-timeout": {
        const v = flags[++i];
        if (v !== "deny" && v !== "local") fail(`invalid --on-remote-timeout: ${v}`);
        onRemoteTimeout = v;
        break;
      }
      case "--remote-poll-ms": {
        const v = Number(flags[++i]);
        if (!Number.isInteger(v) || v < 100) fail(`invalid --remote-poll-ms (minimum 100): ${flags[i]}`);
        remotePollMs = v;
        break;
      }
      case "-h":
      case "--help":
        process.stderr.write(HELP);
        process.exit(0);
        break;
      default:
        fail(`Unknown flag: ${f}`);
    }
  }

  if (opts.httpUrl && cmd.length > 0) {
    fail("Use --http OR '-- <command>', never both.");
  }
  if (!opts.httpUrl && cmd.length === 0) {
    fail("Missing '--' followed by the MCP server command (or use --http <url>).");
  }
  if (!opts.serverLabel) {
    opts.serverLabel = (opts.httpUrl ?? cmd.join(" ")).slice(0, 60);
  }
  if (remoteUrl) {
    if (!remoteKey) fail("--remote requires --remote-key (or env CHRONOMCP_REMOTE_KEY).");
    opts.remote = { url: remoteUrl, apiKey: remoteKey, timeoutMs: remoteTimeoutMs, pollMs: remotePollMs, onTimeout: onRemoteTimeout };
  }

  return { opts, cmd };
}

function buildTransport(opts: GuardOptions, cmd: string[]): ServerTransport {
  if (opts.httpUrl) {
    return new HttpServerTransport(opts.httpUrl, opts.httpHeaders, opts.maxLineBytes);
  }
  const child = spawn(cmd[0]!, cmd.slice(1), {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  child.on("error", (err) => {
    process.stderr.write(`ChronoMCP: failed to start the MCP server: ${err.message}\n`);
    process.exit(1);
  });
  return new StdioServerTransport(child, opts.maxLineBytes);
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv[0] === "verify") runVerify(argv.slice(1));

  const { opts, cmd } = parseArgs(argv);

  const audit = new AuditLog(opts.auditPath);
  const proxy = new GuardProxy(buildTransport(opts, cmd), opts, audit);
  proxy.start();

  process.on("SIGINT", () => proxy.shutdown("SIGINT"));
  process.on("SIGTERM", () => proxy.shutdown("SIGTERM"));

  const envTag = opts.environment
    ? ` · env=${opts.environment}${/prod/i.test(opts.environment) ? " ⚠ PRODUCTION" : ""}`
    : "";
  process.stderr.write(
    `ChronoMCP guard active · mode=${opts.mode} saga=${opts.saga}${envTag} · transport=${opts.httpUrl ? "http" : "stdio"} · audit=${opts.auditPath}\n`,
  );
}

main();
