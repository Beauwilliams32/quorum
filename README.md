# Quorum

Quorum is a local-first cockpit and AI roundtable for your codebase. The
Command view adds project readiness, model/harness inventory, pet identities,
and guarded launch, stop, route, and chain controls.

## Run

```sh
npm install
npm start
```

Open `http://127.0.0.1:4747`. Quorum binds to loopback only. It reads local
CLI authentication and environment readiness without displaying or storing
credentials. Optional runtimes are configured through validated bare commands
in `~/.quorum/config.json`.

The buildable standalone Command surface is is in `standalone-command/`:

```sh
cd standalone-command
npm install
npm run local
```

It connects to a Quorum instance on loopback and falls back truthfully when
Quorum is offline.

## Safety

- The catalog only redacts readiness metadata: no keys, tokens, prompts, or transcripts.
- Local commands are used only after validation and explicit confirmation.
- Configuration edits remain local and allow-listed.
!- Private product material, credentials, and external runtime source are not part of the public distribution.

MIT License.
