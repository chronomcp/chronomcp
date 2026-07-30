import { closeSync, openSync, readSync, writeSync } from "node:fs";

/**
 * Ask a human for approval via the controlling terminal (/dev/tty).
 * We cannot use process.stdin: it carries the MCP JSON-RPC stream.
 * Returns null when no TTY is available (caller applies onNoTty policy).
 */
export function askApprovalSync(promptText: string): boolean | null {
  let fd: number;
  try {
    fd = openSync("/dev/tty", "r+");
  } catch {
    return null; // no controlling terminal (e.g., launched by a desktop MCP client)
  }

  try {
    writeSync(fd, promptText + "\nApprove? [y/N] ");
    const buf = Buffer.alloc(64);
    const n = readSync(fd, buf, 0, 64, null);
    const answer = buf.subarray(0, Math.max(n, 0)).toString("utf8").trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
