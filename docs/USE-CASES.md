# ChronoMCP in the real world — six scenarios

Every scenario below follows the same shape: **an agent doing useful multistep work, one step that can hurt, and what the guard does about it.** All of them run today with `chronomcp guard` — the tool declarations shown use the [`mcp-compensate`](../spec/mcp-compensate/SPEC.md) extension.

---

## 1. The e-commerce refund that half-happened

**The agent's job:** process a product return — create the return label, restock the item, notify the customer, refund the card.

**What goes wrong:** the refund API times out on step 4. Without a guard: label created, stock adjusted, customer told "your refund is on the way" — and no refund exists. Support ticket incoming.

**With ChronoMCP:** steps 1–2 are declared `compensable` (cancel label / re-adjust stock) and get rolled back automatically, LIFO. Step 3 (the email) is declared `irreversible` — the report says so honestly, so your team knows the customer was already notified and can follow up. The failed refund never silently disappears: everything is in the hash-chained audit log.

```jsonc
"refund_payment": { "reversibility": "irreversible",
  "sideEffectScope": ["payments"],
  "notes": "A refund is a new transaction; it cannot be un-issued." }
```

---

## 2. The DevOps agent that deletes with confidence

**The agent's job:** clean up a staging environment — remove test users, drop temp tables, delete old buckets.

**What goes wrong:** the classic. In July 2025 an AI coding agent famously deleted a company's **production** database. Name-based confusion (`prod` vs `staging`) is exactly the kind of mistake agents make.

**With ChronoMCP:** `drop_table` and `delete_bucket` classify as `destructive` — in `--mode block` they are denied outright; in `--mode gate` a human sees the impact diff *before* anything runs:

```
│ [DANGER] infra-mcp → drop_table
│   table: customers_prod        ← a human catches this in one second
│ reversible: NO — IRREVERSIBLE effect declared by the server
Approve? [y/N]
```

One glance at `customers_prod` in the diff and the human types `n`. That's the whole product in one screenshot.

---

## 3. Customer onboarding across three systems

**The agent's job:** create the CRM record, provision the account, grant access, send the welcome email, start the subscription billing.

**What goes wrong:** billing fails on step 5 — but the customer already has an account, access, and a "welcome!" in their inbox.

**With ChronoMCP (saga mode):** access is revoked, the account deprovisioned, the CRM record removed — automatically, in reverse order, *before* the agent even sees the error. The welcome email is honestly reported as irreversible so a human can send the "sorry, one more step" follow-up. State never diverges silently across systems.

---

## 4. The finance agent under compliance

**The agent's job:** issue invoices and schedule supplier payments from an approved list.

**What goes wrong:** nothing — until the auditor asks *"who approved this US$ 40,000 payment, and can you prove the log wasn't edited?"*

**With ChronoMCP + control plane:** payments carry `sideEffectScope: ["payments"]`, and a policy says payments need **2 distinct approvers**. The first approval holds the transaction at `PROPOSED (1/2)` — money moves only after the second. Every intent, approval and outcome lands in an append-only log where each entry is chained by sha256: edit one line and the chain visibly breaks. The auditor can verify it themselves with the CLI’s `verify` command, without trusting us.

---

## 5. The marketing agent with a big red button

**The agent's job:** update 2,000 CRM leads and send a campaign.

**What goes wrong:** the campaign goes to the wrong segment. There is no unsend.

**With ChronoMCP:** the lead updates are `compensable` (bulk revert declared by the server). The send is `irreversible` and scoped `["email"]` — your policy can require the marketing lead's explicit approval for that scope only, while letting harmless updates flow. The impact diff shows the segment and the count *before* the button exists.

---

## 6. The database migration with a working undo

**The agent's job:** run a 6-step schema migration.

**What goes wrong:** step 5 fails halfway. Manual midnight archaeology usually follows.

**With ChronoMCP:** each `apply_migration_step` declares its inverse (`revert_migration_step` with the step id mapped from the call's own output). On failure, the guard walks the completed steps backwards and reverts them — deterministically, from static declarations. **No LLM decides anything during rollback**; a prompt-injected agent cannot "improvise" the recovery.

---

## The pattern

| Without the guard | With ChronoMCP |
|---|---|
| Partial failures leave silent inconsistent state | LIFO compensation, automatic, before the agent resumes |
| Dangerous calls run unnoticed | Impact diff + human gate (terminal, policy, or Slack quorum) |
| "Undo" tools that quietly can't undo | Irreversibility declared and flagged **before** approval |
| Logs you have to trust | Hash-chained audit anyone can verify |

Try scenario 3 yourself in 30 seconds:

```bash
npm install -g chronomcp
git clone https://github.com/chronomcp/chronomcp && cd chronomcp   # the demo server ships here
chronomcp guard --mode gate --saga -- node examples/server-demo/server.mjs
```
