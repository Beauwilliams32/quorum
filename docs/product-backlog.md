# Product backlog — Quorum

Near-term work after the Mission Control → UAO rebrand (2026-08-10). Ordered by
leverage, not by fantasy roadmap.

## Done in this pass

- [x] Product surface is the Node cockpit on `:4747`
- [x] Brand strings Quorum
- [x] Phase-0 Rust/Tauri quarantined under `archive/phase0-coordinator/`
- [x] `npm start` / `npm run check` as canonical scripts

## Done — Office floor (2026-08-10)

- [x] Project rooms catalog (`src/collectors/projects.js`) mapped from `~/CLAUDE/*` cwds
- [x] Session cards carry `projectId`
- [x] Office | Radar view toggle (Office default)
- [x] Seat teammate PTY spawn into room cwd + `~/.quorum/presence.json` stamp
- [x] `npm test` for cwd→project mapping

## Done — Studio + Roundtable (2026-08-17)

- [x] Cast of six characters with a shared drawn style (`src/cast.js`, `public/art.js`)
- [x] Rooms rendered as stages; live sessions stand in them with a stable face
- [x] Steering by drag: character → room seats a debater, runtime → room spawns a PTY
- [x] **Roundtable**: blind parallel openings → forced cross-examination → converge → verdict
- [x] Per-turn cost tracking, pre-flight estimate, working cancel
- [x] Decision-record export (`/api/roundtable/<id>.md`), debates persisted to disk
- [x] `?view=` deep links; empty terminal drawer no longer reserves 260px

Verified end-to-end against a real debate (3 seats, sonnet, 11 turns, $0.947).
## Done — Command Deck (2026-08-18)

- [x] Added a live `Deck` view backed by the existing WebSocket state stream.
- [x] Added CSS-3D project nodes with active-session elevation and hover depth.
- [x] Added agent nodes linked to chat and transcript handoff.
- [x] Added live system pressure, process, room, session, and CLI counts.
- [x] Added project selection, session drill-down, PTY seating, and Radar/Office handoff.
- [x] Added regression coverage for Deck markup, state/action wiring, and 3D styling.

## Next (productize the cockpit)

1. **Stable launch** — ✅ checked-in launchd plist plus `/health` readiness endpoint; installation remains an explicit local operator action.
2. **Session coverage** — ✅ Claude and Codex transcript cards/tailing are live; Hermes remains represented by gateway health because no durable Hermes transcript path is exposed.
3. **UX polish** — tighten empty states, connection loss, and kill confirm copy under the UAO brand (no fake "SYSTEM ARMED" facade).
4. **Packaging later** — optional Tauri/shell wrapper around this same server; do not rebuild collectors in Rust first.
5. **Cursor SessionStart hook** (optional) — append the same presence file when cwd is under `~/CLAUDE/`.

## Port from Phase-0 when actually needed

Only pull these when multi-agent isolation or durable supervised runs hurt without them:

| Phase-0 idea | Why wait |
|---|---|
| Git worktree leases | Cockpit observes existing activity; leasing matters once UAO *owns* agent write targets |
| Recovery classification + PID start-key | Needed once UAO launches supervised runs (not just terminals) |
| Write-scope metadata | Metadata-only in Phase-0; real enforcement is a larger OS/sandbox effort |

See [`archive/phase0-coordinator/QUARANTINE.md`](../archive/phase0-coordinator/QUARANTINE.md).

## Blocking a paid release

Full reasoning in [`product-plan.md`](product-plan.md) §5. The two that can stop
the product outright:

1. **`PROJECT_CATALOG` is hardcoded to Beau's repos.** On anyone else's machine
   the floor is empty and the product looks broken in the first 30 seconds.
   Needs directory scanning + a first-run picker.
2. **Unverified: whether Anthropic's terms permit driving `claude -p` inside
   resold software.** Cheap to check, and the whole BYO-key architecture rests
   on it. Do this before writing any sales copy.

## Explicit non-goals (for now)

- Cloud sync / telemetry
- Replacing Claude/Codex/Hermes auth with an operator-owned credential store
- Auto-restarting writer processes
- Finishing the Phase-0 Tauri dashboard as a parallel product
