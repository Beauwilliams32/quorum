# Quorum — the agentic OS for your projects

Quorum is a local-first agentic OS: a cockpit, memory index, mission control
plane, and adversarial AI roundtable for the projects on your machine. It helps
you understand what is wrong, decide what matters, and move verified work to
completion while keeping high-impact actions under your control.

The Command view adds project readiness, model/harness inventory, pet
identities, and guarded launch, stop, route, and chain controls. The operator
memory contract in `docs/agent-control/operator-memory.md` tells the system
which durable sources and skills to read without copying your private vault.

## Run

```sh
npm install
npm start
```

Open `http://127.0.0.1:4747`. Quorum binds to loopback only. It reads local
CLI authentication and environment readiness without displaying or storing
credentials. Optional runtimes are configured through validated bare commands
in `~/.quorum/config.json`.

The buildable standalone Command surface is in `standalone-command/`:

```sh
cd standalone-command
npm install
npm run local
```

It connects to a Quorum instance on loopback and falls back truthfully when
Quorum is offline.

## Safety

- The catalog exposes readiness metadata only: no keys, tokens, prompts, or transcripts.
- Launch, stop, route, chain, and configuration actions require allowlisted inputs and explicit confirmation.
- Stops are limited to Quorum-tracked PTYs and processes.
- Roundtable turns preserve cost preview, cancellation, and tool/MCP stripping.
- Configuration writes are limited to project roots, labels, runtimes, model mappings, pet preferences, and display settings.
- Pet assets remain local under `~/.quorum/pets`; deterministic fallback pets work without an image tool.

## Public boundary

This repository contains the open-core runtime, tests, and installation docs.
Private product material, internal architecture, credentials, and external
runtime source are not part of the public distribution.

MIT License.
