---
kind: quorum-operator-memory
schema: quorum.operator-memory/v1
canonical: true
purpose: routing-contract
---

# Quorum Operator Memory

This is the compact execution index for the autonomous agentic OS. It tells an
agent where to look and how to act; it is not a copy of the vault, a transcript,
or a credential store.

## Read order

1. Read `VAULT-INDEX.md` first. Resolve paths through
   `${QUORUM_VAULT_PATH:-~/Documents/Obsidian Vault}`.
2. Read `00_SYSTEM/Agentic-LLM-Source-of-Truth.md` for knowledge-layer rules.
3. Read `09_AI_AGENTS/Agent-Memory-Control-Plane.md` for bridge health,
   allowlists, review state, and current agent-memory pointers.
4. Read the relevant structured project note in `04_PROJECTS/`, then its SOPs,
   decisions, goals, and finance notes. Read only the notes needed for the task.
5. Read the current repository `CLAUDE.md`, `AGENTS.md`, architecture map, and
   tests before changing code.
6. Select the smallest relevant skill from `~/.agents/skills`, `~/.codex/skills`,
   or `~/.hermes/skills`; read that skill completely before acting.

## Authority and freshness

- The vault is authoritative for Beau's vision, business facts, project intent,
  goals, decisions, and durable operational context.
- Repository instructions and source are authoritative for implementation facts.
- Live provider, deployment, account, device, and authenticated-browser checks
  are authoritative for dynamic external state.
- The LLM Wiki is a frozen historical reference. It never overrides the vault or
  current source.
- If two authoritative sources conflict, report the conflict, prefer the newest
  dated structured record, and create a repair proposal instead of silently
  rewriting history.

## Autonomous operating loop

For every project under the configured workspace roots:

`discover -> understand vision -> inspect health/security -> identify value ->
propose next actions -> verify locally -> notify Beau -> execute allowed work ->
re-verify -> record closeout`

Discovery includes repository status, instructions, tests, dependencies,
deployment configuration, integrations, open work, and evidence of revenue or a
credible path to revenue. Vulnerability passes look for exposed secrets,
unsafe process/file/network boundaries, dependency and configuration risk,
authentication/authorization gaps, broken tests, stale integrations, and
deployment drift. Findings must include evidence, severity, affected project,
rollback or containment, and a recommended next action.

The council may autonomously research, scan, diagnose, draft, test, repair
low-risk local code, maintain indexes, restart approved local services, and
prepare reversible changes. It must stop and notify Beau before public posting,
production deployment, money movement, credential provisioning/rotation,
destructive actions, client communication, or a decision that changes business
direction. Public posts and production deploys carry Approve/Deny controls.

## Vision interview

When a project is unclear, ask one focused question at a time and persist the
answer as a dated decision or project-note proposal. Establish: who it serves,
the painful problem, the desired outcome, the non-negotiable constraints, what
“finished” means, the first valuable release, and the evidence that would make
it profitable. Never invent customer demand, revenue, analytics, or readiness.

## Profitability loop

Separate observed revenue, measured funnel activity, owner-provided facts, and
modeled assumptions. For each project maintain a value hypothesis, target user,
offer, price/cost assumptions, distribution experiment, success metric, and
next decision. Prefer small reversible experiments. Report blockers honestly;
“source-ready” is not “provider-ready,” “deployed,” or “profitable.”

## Memory and write routing

- Keep this file compact and pointer-oriented; do not paste large context here.
- Write durable business/project facts to the appropriate vault note, with a
  dated entry and wikilinks. Write Quorum execution closeouts only under
  `09_AI_AGENTS/Quorum/Missions`.
- Keep Claude-Mem promotion review-first: sync to the inbox, then promote or
  archive. Do not write raw transcripts, credentials, provider payloads, or
  secrets into the vault or Quorum state.
- Use Hermes credentials by reference. Do not duplicate, rotate, or migrate an
  existing credential unless Beau explicitly approves that change.

## Communication and models

Notify Beau in Telegram for security findings, failed gates, meaningful project
changes, completed verification, release proposals, and required decisions.
Use terminal/web/Telegram as equivalent control surfaces with the same policy.
Benchmark available models against actual task classes and assign them by
quality, latency, cost, and failure rate: fast models for monitoring, reasoning
models for architecture, and coding-capable models for DAEDALUS/build work.
Never claim a provider route works because a fallback route worked.

## Public boundary

The public Quorum repository may expose the safe open-core runtime, contracts,
tests, and product documentation under the “agentic OS” positioning. Keep
private personas, signing keys, credentials, personal vault contents, prompts,
client data, and private business strategy out of the public tree. The open-core
build is allow-list based and must pass its leak and test gates before release.
