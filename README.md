# Quorum

Quorum is a local-first cockpit and AI roundtable for your codebase. The
Command view adds project readiness, model/harness inventory, pet identities,
and guarded launch, stop, route, and chain controls.

## Quick start

```sh
curl -fsSL https://raw.githubusercontent.com/Beauwilliams32/quorum/main/scripts/install.sh | bash
```

Clones to `~/.quorum/app`, installs, verifies, and tells you how to start. Then:

```sh
cd ~/.quorum/app && npm start        # → http://127.0.0.1:4747
```

A seven-step guided tour runs on first launch (`?` in the top bar replays it),
and your projects are discovered automatically — there is nothing to configure
before it works.

<details>
<summary>Prefer to clone it yourself</summary>

```sh
git clone https://github.com/Beauwilliams32/quorum.git
cd quorum
npm install
npm start          # → http://127.0.0.1:4747
npm run check      # syntax sweep
npm test           # full suite
npm start
```
</details>

**Requirements:** Node 20+, git, and the
[Claude Code CLI](https://claude.com/claude-code) signed in — debate turns run
as headless `claude -p` processes on your own account. The cockpit runs without
it; the roundtable doesn't.

### Let a model set it up for you

```sh
npm run bootstrap              # propose a setup, print it, write nothing
npm run bootstrap -- --apply   # write it, then re-run the test suite
```

Reads which directories your AI sessions actually run in, which agent CLIs are
installed, and your workspace's own `CLAUDE.md`, then proposes labelled rooms
and runtimes. **Transcripts are never sent** — only derived signal (paths,
counts, headings). The proposal is validated before it is shown, your existing
config is backed up before it is replaced, and `--apply` verifies the build
afterwards.

Open `http://127.0.0.1:4747`. Quorum binds to loopback only. It reads local
CLI authentication and environment readiness without displaying or storing
credentials. Optional runtimes are configured through validated bare commands
in `~/.quorum/config.json`.

## Projects are discovered, not configured

The floor populates automatically: Quorum scans your workspace roots
(`~/CLAUDE`, `~/code`, `~/dev`, `~/src`, `~/projects`, `~/workspace` — whichever
exist) and any folder with a `.git`, `package.json`, `CLAUDE.md`,
`wrangler.toml`, `Cargo.toml`, `pyproject.toml`, `go.mod` or `Makefile` becomes
a room.

To take control, create `~/.quorum/config.json`:

```json
{
  "roots": ["~/code", "~/work"],
  "projects": [{ "id": "api", "label": "Billing API", "path": "~/code/api" }],
  "hidden": ["some-discovered-id"],
  "runtimes": [{ "id": "gemini", "label": "gemini", "command": "gemini" }],
  "models": ["claude-opus-4-1"]
}
```

Explicit `projects` win over discovery; `hidden` suppresses rooms you don't
want. The file is re-read every 30 seconds — edits apply without a restart.

## Bring your own agents and models

`runtimes` adds any agent CLI on your PATH — gemini, aider, goose, opencode, an
internal wrapper — as a one-keystroke launch button everywhere terminals can be
spawned. `models` adds any model name the `claude` CLI accepts to the
roundtable's model picker, full model ids included.

Both are validated before they load. A runtime `command` must be a bare program
name or absolute path: **no arguments, no shell metacharacters**. That line is
what keeps a config file from becoming a way to run arbitrary shell, and it is
covered by tests in `test/validate.test.mjs`.

## The roundtable

Seat 2–5 of the crew and pose a question. Four phases:

1. **Opening** — written **in parallel and blind**. No participant sees another's,
   so positions are independent rather than anchored on whoever spoke first.
2. **Clash** — everyone sees every opening and must *name* the strongest argument
   against themselves, then rebut it concretely or concede out loud. Conceding is
   recorded, not penalised.
3. **Converge** — a final position and what changed. Confidence is tracked across
   phases, so a mind actually changing is visible.
4. **Verdict** — the moderator writes the decision, the dissent that survived,
   and what is still unknown.

Each turn is a separate headless agent with **tools and MCP stripped**: debaters
reason, they never touch your files — and a turn costs ~$0.08 instead of ~$0.27
with the default toolset loaded. The turn count and a cost estimate are shown
before you spend anything, the running total is live, and cancel kills the child
processes.

Debates are grounded in the selected room's directory, so that project's own
`CLAUDE.md` is context and the argument is about *your* codebase.

Finished debates persist to `~/.quorum/roundtables/` and export as a decision
record: `GET /api/roundtable/<id>.md`.

## The crew

Each persona is given something different to lose. That is what produces
friction instead of agreement.

| | Role | Argues from | Edition |
|---|---|---|---|
| **Nib** | Moderator | frames the decision, writes the record, never takes a side | Free |
| **Vex** | Architect | two-year coupling cost, blast radius, boundaries | Free |
| **Bolt** | Builder | shortest path to something running and testable today | Free |
| **Sable** | Adversary | paid to break it — concrete failure modes, not vague worries | Pro |
| **Muse** | Designer | the person holding it, naming, defaults, silent failures | Pro |
| **Ledger** | Operator | monitoring, rollback, cost, who gets woken at 3am | Pro |

**The free edition runs real debates.** Vex and Bolt are directly opposed —
long-term cost against shipping today — and Nib moderates. That is a genuine
two-sided argument, not a demo.

**Quorum Pro** adds the full six-character crew and lets you write your own
specialists as JSON in `~/.quorum/cast/`. Drop the licence file at
`~/.quorum/licence.json` and restart.

## Views

| View | What |
|---|---|
| **Studio / Office** (default) | The crew, runtime launchers, team desks, and project rooms. Live sessions stand in the room matching their cwd; drag a character or runtime onto a room to steer it there. |
| **Roundtable** | Convene a debate, watch it happen, and export the decision record. |
| **Deck** | Interactive CSS-3D command room: project nodes, agent nodes, live system pressure, sessions, transcript handoff, real PTY seating, and shared memory pending count. |
| **Board** | Global task board plus Composio, live agents, and the Agent Memory Control Plane status card. |
| **Radar** | Classic sessions list + live transcript + system/Comfy/Hermes panels. |

Add `?view=office|table|deck|board|radar` to link a view directly.

## What it shows

| Pane | Source | Cadence |
|---|---|---|
| Studio / Office rooms | Session `cwd` → project catalog + process groups | 2s |
| Sessions (Radar) | `~/.claude/projects/**/*.jsonl` + `~/.codex/sessions/**` — sessions touched in 48h, with live "what is it doing" summaries. BG badge = background job. | 3s |
| Live transcript (center) | Click a session → its transcript tails in realtime. | 1s |
| System | `vm_stat` + swap — free/compressed/swap charts. | 2s |
| Render engine | ComfyUI `:8188` (+ HF download detection). | 5s |
| Hermes | Gateway `:8644/health` + process count. | 5s |
| Agent auth | Read-only freshness for Codex auth (never writes, never shows tokens). | 5s |
| Memory control | `~/CLAUDE/agent-memory-bridge/config.json`, ledger, Obsidian inbox, and generated control-plane note. Shows allowlist, pending/promoted/archive counts, and drift. | 10s |
| Top memory / Events | `ps` diffing — spawn/exit feed for classified AI processes. | 2.5s |

Presence stamps land in `~/.quorum/presence.json` (no secrets). Data written by
the pre-rename versions in `~/.unified-ai-operator/` is still read, so nothing
is stranded.

## Controls

- **`+ claude` / `+ codex` / `+ hermes` / `+ zsh`** — real PTY terminals in the
  bottom drawer (xterm.js), inheriting your machine credentials.
- **Kill** on tracked AI processes — SIGTERM with confirm, classified pids only.
- **Ctrl+`** toggles the terminal drawer · drag its top edge to resize.
- Terminals live server-side: reload the page and they are still there.

### Launch at login (macOS)
The buildable standalone Command surface is in `standalone-command/`:

```sh
cd standalone-command
npm install
npm run local
```

It connects to a Quorum instance on loopback and falls back truthfully when
Quorum is offline.

## Safety

## UI principles

This is a **Command / Inspect + Monitor** surface, not a marketing page.

- Dark-native cockpit: near-black canvas, low-glare panels, thin structural borders.
- Sans-first hierarchy: labels, rooms, cards, and controls use the UI sans stack; monospace is reserved for terminal output, ids, paths, timestamps, and metrics.
- One primary accent: Trident cyan marks selection and command affordance only. Status colors stay semantic: green = available/healthy, yellow = watch, red = down/error, purple = agent/Codex-class context.
- Data density wins: cards and lists stay compact, but every title/metadata/status tier has distinct contrast.
- Motion is functional only and respects `prefers-reduced-motion`.

## Architecture

```
server.js               http + ws (loopback), static + /health + /api/state
src/state.js            central store, ws diff broadcast
src/pty.js              node-pty terminal manager (scrollback replay on attach)
src/cast.js             the free crew + the live cast registry
src/cast-locked.js      appearance-only metadata for the Pro crew
src/edition.js          resolves free/Pro, registers Pro + custom characters
src/licence.js          offline Ed25519 licence verification
src/roundtable.js       debate protocol, turn execution, cost, cancellation
src/decision-record.js  finished debate → exportable markdown ADR
src/paths.js            data dir, with the pre-rename home still readable
src/config.js           ~/.quorum/config.json + project auto-discovery
src/validate.js         validates generated config/persona/runtime files
public/art.js           character + room SVG art — one silhouette, six identities
public/                 single-page UI (no build step)
src/collectors/         processes · sessions · services · system · projects · tasks · composio · agents · memory
archive/phase0-coordinator/   quarantined Rust/Tauri Phase-0 (not the product)
```
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
