import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { AuditEntry, JsonValue } from "./types.js";

function sha256(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * Append-only JSONL audit log with a hash chain. Tampering with any line breaks
 * the chain from that line on.
 *
 * The hash of entry n is:
 *
 *   hash_n = sha256(utf8(serialize({ ts, event, data, prevHash })))
 *
 * where `prevHash` is hash_{n-1} ("GENESIS" for the first entry) and is a FIELD
 * INSIDE the hashed object — it is not concatenated separately. The `hash` field
 * itself is excluded from its own preimage and appended last, so the line on disk
 * is `{ ts, event, data, prevHash, hash }`.
 *
 * `serialize` is `JSON.stringify` with the key order above. There is NO
 * canonicalisation step: the preimage depends on JavaScript's key ordering and
 * string escaping. A third party reproducing this in another language must
 * preserve the key order exactly as it appears on the line and match
 * `JSON.stringify`'s escaping. Verified behaviour: `/` is NOT escaped, non-ASCII
 * is emitted raw as UTF-8 (`café`, not `café`), C0 control characters use
 * the short `\n`/`\t` forms where they exist and `\u00XX` otherwise, lone
 * surrogates are escaped as `\udXXX`, and there is no whitespace anywhere.
 * `verifyChain` below re-derives the preimage by dropping `hash` from the parsed
 * object, which keeps the original key order.
 */
export class AuditLog {
  private prevHash = "GENESIS";

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
      const last = lines[lines.length - 1];
      if (last) {
        try {
          const parsed = JSON.parse(last) as AuditEntry;
          if (typeof parsed.hash === "string") this.prevHash = parsed.hash;
        } catch {
          // corrupted tail: keep chain going from GENESIS marker of corruption
          this.prevHash = "CORRUPTED_TAIL";
        }
      }
    }
  }

  write(event: AuditEntry["event"], data: Record<string, JsonValue>): void {
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      event,
      data,
      prevHash: this.prevHash,
    };
    const body = JSON.stringify(entry);
    const hash = sha256(body);
    entry.hash = hash;
    appendFileSync(this.path, JSON.stringify(entry) + "\n", "utf8");
    this.prevHash = hash;
  }
}

export type ChainCheck =
  | { ok: true; entries: number }
  | { ok: false; brokenAt: number; reason: "hash" | "prevHash" };

/**
 * Recomputa a cadeia inteira com a MESMA logica do write(): para cada entrada,
 * o hash e sha256 do JSON sem o campo `hash` (ordem de chaves preservada pelo
 * parse) e o prevHash deve ser o hash da entrada anterior (GENESIS na
 * primeira). Reutilizada pelo comando `chronomcp verify`.
 * brokenAt e o indice 0-based da primeira entrada que quebra a cadeia.
 */
export function verifyChain(entries: AuditEntry[]): ChainCheck {
  let prev = "GENESIS";
  for (let i = 0; i < entries.length; i++) {
    const { hash, ...body } = entries[i]!;
    if (body.prevHash !== prev) return { ok: false, brokenAt: i, reason: "prevHash" };
    if (typeof hash !== "string" || sha256(JSON.stringify(body)) !== hash) {
      return { ok: false, brokenAt: i, reason: "hash" };
    }
    prev = hash;
  }
  return { ok: true, entries: entries.length };
}
