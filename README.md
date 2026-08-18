# Quorum

**The writers' room for your codebase.**

Ask a question, seat a table of AI specialists, and they argue it out — then hand
you a decision record including the dissent that survived.

Quorum is local-first and runs on `127.0.0.1`. It is also a cockpit for the AI
activity already on your machine: Claude Code sessions, background jobs, Hermes,
Codex, ComfyUI renders and memory pressure, in one page with embedded terminals.

> Previously "Unified AI Operator", and before that "Mission Control". The
> earlier Rust/Tauri Phase-0 coordinator is quarantined under
> [`archive/phase0-coordinator/`](archive/phase0-coordinator/QUARANTINE.md).

## Why it exists

Ask one model whether to use a queue and it will tell you yes. Ask five and,
naively, all five say yes — they read each other's answers as context to agree
with, and you end up with one opinion wearing five hats. That is worse than a
single answer, because it looks like corroboration.

Quorum is built so agreement has to be **earned**.

## Run

```sh
npm install
npm start          # → http://127.0.0.1:4747
npm run check
npm test
```

`PORT=5000 npm start` to change the port. `GET /health` returns a secret-free
readiness payload. Binds **127.0.0.1 only** — it can spawn terminals, so it must
never be exposed beyond loopback.

Requires the [Claude Code CLI](https://claude.com/claude-code) installed and
authenticated: debate turns run as headless `claude -p` processes on your own
account.

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
| **Studio** (default) | The crew and your project rooms, drawn as stages. Live sessions stand in the room matching their cwd. Drag a character or a runtime onto a room to steer it there. |
| **Roundtable** | Convene a debate, watch it happen, export the record. |
| **Deck** | Interactive CSS-3D command room: project nodes, agent nodes, live system pressure, sessions, transcript handoff, and real PTY seating. |
| **Board** | Global task board across sessions + Composio connection health. |
| **Radar** | Sessions list, live transcript, system/Comfy/Hermes panels. |

Add `?view=office|table|deck|board|radar` to link a view directly.

## What it shows

| Pane | Source | Cadence |
|---|---|---|
| Studio rooms | Session `cwd` → project catalog + process groups | 2s |
| Sessions | `~/.claude/projects/**/*.jsonl` + `~/.codex/sessions/**`, touched in 48h | 3s |
| Live transcript | Click a session → tails in realtime | 1s |
| System | `vm_stat` + swap — free/compressed/swap charts | 2s |
| Render engine | ComfyUI `:8188` (+ HF download detection) | 5s |
| Hermes | Gateway `:8644/health` + process count | 5s |
| Agent auth | Read-only freshness (never writes, never shows tokens) | 5s |
| Top memory / Events | `ps` diffing — spawn/exit feed | 2.5s |

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

```sh
mkdir -p ~/Library/Logs
cp launchd/com.tridentsocial.quorum.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tridentsocial.quorum.plist
curl --fail http://127.0.0.1:4747/health
```

Unload with `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.tridentsocial.quorum.plist`.

> Upgrading from the old name? Unload the old agent first, or two copies will
> fight over port 4747:
> `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.tridentsocial.unified-ai-operator.plist`

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
public/art.js           character + room SVG art — one silhouette, six identities
public/                 single-page UI (no build step)
src/collectors/         processes · sessions · services · system · projects · tasks
archive/phase0-coordinator/   quarantined Rust/Tauri Phase-0 (not the product)
```

## Licence

MIT for the open core. The Pro cast and custom-cast authoring are commercial.
