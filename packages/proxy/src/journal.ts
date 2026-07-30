// Durable journal of the saga stack (gap: a crash with no trace).
//
// The in-memory stack dies with the process. This journal persists a snapshot
// of the stack (writeFileSync, synchronous) on each push and each rollback step,
// at `<audit dir>/saga-<sessionId>.json`. If the proxy dies without compensating
// (crash, SIGKILL, power loss), the file survives and the NEXT session
// warns on stderr that there is an incomplete saga.
//
// Automatic recovery is deliberately NOT done: re-running compensations
// without the original session's server/state is risky (the world may have
// changed). The journal guarantees the TRACE; the decision to compensate is human.
//
// Documented limitation: there is a millisecond window between the tool's effect
// on the server and the push's persist() — a crash exactly there leaves the
// step out of the journal. The audit log (tool_call_result) covers that window.
// Besides, the journal is never deleted automatically in FUTURE sessions:
// the warning repeats until a human reviews and removes the file.
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExecutedStep } from "./types.js";

const JOURNAL_FILE_RE = /^saga-[A-Za-z0-9-]+\.json$/;

export class SagaJournal {
  private readonly path: string;
  private written = false;

  constructor(
    private readonly dir: string,
    private readonly sessionId: string,
  ) {
    this.path = join(dir, `saga-${sessionId}.json`);
  }

  /** Synchronous snapshot of the current stack. Best-effort: a full disk must not bring down the MCP session. */
  persist(stack: ExecutedStep[]): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(
        this.path,
        JSON.stringify({
          sessionId: this.sessionId,
          updatedAt: new Date().toISOString(),
          steps: stack,
        }) + "\n",
        "utf8",
      );
      this.written = true;
    } catch (err) {
      process.stderr.write(
        `! ChronoMCP: failed to write the saga journal (degraded trace): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  /**
   * Clean end-of-life for the journal: a full rollback (stack drained) or a normal
   * end of session (pending steps = COMMITTED, nothing to compensate).
   */
  finalize(): void {
    if (!this.written) return;
    try {
      unlinkSync(this.path);
    } catch {
      /* already removed */
    }
    this.written = false;
  }
}

export interface StaleJournal {
  path: string;
  /** Number of uncompensated steps; -1 = unreadable file. */
  steps: number;
}

/**
 * Looks for unfinalized journals from PREVIOUS sessions in the audit
 * directory. Journals with an empty stack (rollback drained, crash before unlink)
 * pose no risk and are ignored. Never deletes anything: the trace is sacred.
 */
export function findStaleJournals(dir: string, currentSessionId: string): StaleJournal[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const out: StaleJournal[] = [];
  for (const f of files) {
    if (!JOURNAL_FILE_RE.test(f) || f === `saga-${currentSessionId}.json`) continue;
    const p = join(dir, f);
    let steps = -1;
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8")) as { steps?: unknown };
      if (Array.isArray(parsed.steps)) steps = parsed.steps.length;
    } catch {
      /* unreadable: report it anyway (steps = -1) */
    }
    if (steps === 0) continue;
    out.push({ path: p, steps });
  }
  return out;
}
