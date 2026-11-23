# Security Policy

ChronoMCP sits between an AI agent and the real world. A flaw here can let a
call that should have been stopped go through. We take reports seriously.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use one of these instead:

1. **GitHub private advisory** (preferred) — on this repository, go to
   *Security → Advisories → Report a vulnerability*. This gives us a private
   thread and a CVE path.
2. **Email** — `hello@chronomcp.dev`, with `SECURITY` in the subject line.

Please include: what you did, what happened, what you expected, the version
(`chronomcp --version` or the commit), and your OS and Node version. A minimal
reproduction — an MCP server stub plus the exact `chronomcp guard` invocation —
helps more than anything else.

### What to expect

| | |
|---|---|
| First response | within 3 business days |
| Assessment and severity | within 10 business days |
| Fix for a confirmed high-severity issue | we aim for 30 days from confirmation |

We will keep you updated, credit you in the advisory unless you prefer
otherwise, and tell you plainly if we decide not to fix something and why.

## Supported versions

Only the latest published `chronomcp` release on npm receives security fixes.
There are no long-term support branches.

## Scope

This repository holds the MIT core: the `mcp-compensate` specification draft,
the `chronomcp` guard proxy CLI, and the example server.

### Threat model — what the guard trusts, and when it should not

Read this before deciding whether something is a bug. By **default** ChronoMCP
classifies an action using, in order: the `mcp-compensate` metadata the server
declares, the native MCP annotations the server declares, and the tool name the
server chose. All three are supplied by **the very server being guarded**.

That is deliberate (ADR #2: an explicit source beats a heuristic) and it is the
right incentive for a *careless* server — declaring buys it a faster path. It is
**not** a defense against a *hostile* server, which can simply declare
`readOnlyHint: true`, or name a shell wrapper `ping_host` so it lands in the
read allowlist. Neither requires lying about anything verifiable.

If you do not trust the server you are wrapping, run it with
`--untrusted-server`. Then only **escalation** is honored: nothing the server
says can lower an action's class, the floor becomes `mutating` so every call is
gated, and a declared undo is shown to the human as an `UNVERIFIED` claim
instead of as fact. A report that a hostile server bypasses the gate **with**
that flag on is in scope and serious. Without it, the default trust is the
documented behavior above — though we still want to hear about a read verb in
the allowlist that commonly wraps execution.

Two limits are structural, not bugs:

- **Reads are not gated.** The threat model is unapproved mutation and
  destruction, not confidentiality. A tool that only reads will exfiltrate a
  secret and the guard will record the exact path without stopping it. Use
  `--untrusted-server` to gate reads too.
- **Attacks in tool *descriptions* are invisible.** Tool poisoning and prompt
  injection planted in a description act on the LLM before anything becomes a
  `tools/call`, and inviolable rule #8 requires passing `tools/list` through
  untouched. A scanner that inspects what a server *says* complements this
  guard, which gates what a server *does*.

### In scope — these are the failures that matter most

- **Guard bypass.** Any way to make a mutating or destructive call reach the
  upstream server without passing the configured policy (`log`, `gate`,
  `block`), including through `--remote`.
- **Misclassification that weakens the guard.** A call that should be classified
  `mutating` or `destructive` being treated as `read`.
- **Approval forgery.** Anything that produces an approval the human did not
  give — including reading approval input from `stdin` rather than `/dev/tty`.
- **Audit log tampering.** Breaking the hash chain, or altering entries without
  `chronomcp verify` detecting it.
- **Compensation abuse.** Causing the saga stack to run attacker-chosen
  compensations, or to report an irreversible step as reversible.
- **Prompt injection reaching the control path.** Content from a tool result
  that changes classification, approval, or rollback behavior. Compensation is
  deterministic by design; any path where it is not is a vulnerability.
- **stdout corruption.** Anything that writes non-JSON-RPC bytes to the proxy's
  stdout, since that breaks the MCP stream.
- **Secret leakage.** Credentials, headers, or tokens written to the audit log,
  to stderr, or to the impact diff.

### Out of scope

- Vulnerabilities in the upstream MCP servers you wrap. Report those to their
  maintainers. ChronoMCP's job is to gate and audit calls, not to make an unsafe
  server safe.
- The managed control plane and dashboard (`api.chronomcp.dev`,
  `app.chronomcp.dev`). They are not in this repository — mail
  `hello@chronomcp.dev` and say so.
- An operator deliberately running `--mode log`, approving a destructive call,
  or setting `onNoTty=allow`. Those are documented choices, not flaws.
- Denial of service that needs control of the machine already running the proxy.
- Findings from automated scanners with no demonstrated impact.

## Design commitments you can hold us to

These are inviolable project rules, not aspirations. If you find code that
breaks one, that is a bug report we want:

- **No LLM anywhere in the rollback path.** Compensation is driven only by
  static `toolName` and `parameterMapping` declarations. This is the defense
  against prompt injection in rollback.
- **Zero runtime dependencies in the proxy.** The supply-chain surface is
  deliberately empty.
- **Never claim something is reversible when it is not.** Absent
  `mcp-compensate` metadata, reversibility is *unknown* — never assumed safe.
  Irreversible steps are surfaced in the diff before the commit, not after.
- **The proxy's stdout carries JSON-RPC and nothing else.** All human-facing
  output goes to stderr; the audit trail goes to a file.

## Safe harbour

We will not pursue or support legal action against anyone who makes a good-faith
effort to follow this policy: who tests only against their own installations,
avoids privacy violations and service disruption, and gives us reasonable time
to respond before any public disclosure.
