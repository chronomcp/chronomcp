import { ActionClass, JsonValue, ToolInfo } from "./types.js";

const ICON: Record<ActionClass, string> = {
  read: "READ ",
  mutating: "WRITE",
  destructive: "DANGER",
};

function fmtArgs(args: Record<string, JsonValue> | undefined, indent = "    "): string {
  if (!args || Object.keys(args).length === 0) return `${indent}(no arguments)`;
  return Object.entries(args)
    .map(([k, v]) => {
      const val = typeof v === "string" ? v : JSON.stringify(v);
      const trimmed = val.length > 200 ? val.slice(0, 200) + "…" : val;
      return `${indent}${k}: ${trimmed}`;
    })
    .join("\n");
}

/**
 * Human-readable "business diff" of a proposed tool call.
 * Written to stderr so it never corrupts the MCP stdio stream.
 */
export function renderImpact(opts: {
  serverLabel: string;
  environment?: string;
  toolName: string;
  args: Record<string, JsonValue> | undefined;
  cls: ActionClass;
  tool?: ToolInfo;
}): string {
  const { serverLabel, environment, toolName, args, cls, tool } = opts;

  const lines: string[] = [];
  lines.push("");
  lines.push(`┌─ ChronoMCP · proposed action ───────────────────────────`);
  if (environment) {
    // Environment FIRST — the human must know WHERE this lands before looking
    // at the rest. Anything matching "prod" gets a loud alert to prevent a
    // fatal mistake.
    const isProd = /prod/i.test(environment);
    lines.push(
      isProd
        ? `│ ⚠⚠  ENVIRONMENT: ${environment.toUpperCase()} — REAL PRODUCTION  ⚠⚠`
        : `│ ENVIRONMENT: ${environment.toUpperCase()}`,
    );
    lines.push(`├──────────────────────────────────────────────────────────`);
  }
  lines.push(`│ [${ICON[cls]}] ${serverLabel} → ${toolName}`);
  if (tool?.description) lines.push(`│ ${tool.description}`);
  lines.push(`│ arguments:`);
  for (const l of fmtArgs(args, "│   ").split("\n")) lines.push(l);

  const c = tool?.compensate;
  if (cls !== "read") {
    if (c?.reversibility === "compensable" && c.compensation) {
      lines.push(`│ reversible: YES → undo via ${c.compensation.toolName}`);
      if (c.notes) lines.push(`│ note: ${c.notes}`);
    } else if (c?.reversibility === "irreversible") {
      lines.push(`│ reversible: NO — IRREVERSIBLE effect declared by the server`);
      if (c.notes) lines.push(`│ note: ${c.notes}`);
    } else {
      lines.push(`│ reversible: UNKNOWN — server does not declare mcp-compensate`);
    }
  }
  lines.push(`└──────────────────────────────────────────────────────────`);
  return lines.join("\n");
}
