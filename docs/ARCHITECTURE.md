# Quorum — complete architecture map

Every file, function, message, endpoint and data path in the system, verified
against the code on 2026-08-18. When this document and the code disagree, the
code wins — then fix this document.

```
browser (public/)  ←ws/http→  server.js  ←spawn→  claude -p (debate turns)
                                  │                node-pty (terminals)
                                  ├── src/collectors/*  (poll the machine)
                                  ├── src/roundtable.js (debate engine)
                                  └── ~/.quorum/*       (config, licence, archives)
```

Runtime: a single Node process, no build step, no database, no network beyond
loopback and the `claude` CLI's own API calls. State lives in memory and in
plain JSON files under `~/.quorum/`.

---

## 1. Process entry — `server.js`

| Function | Does |
|---|---|
| (module top) | Static file serving with a path-containment check, vendored xterm assets from `node_modules`, MIME table |
| `handle(ws, m, watcher)` | The websocket message router — every client→server message goes through this one switch |
| `startRoundtable(m)` | Validates seats against the edition's locked list (a locked character throws a readable error instead of silently shrinking the table), resolves the room from the **server-side** catalog (never a client-supplied cwd), starts the debate |
| `openChat(ws, m)` | Chat with a live agent by resuming its session in a PTY: whitelists the sessionId against observed agents, dedupes so a double-submit reuses the open terminal instead of racing `claude --resume` against itself |
| `killProc(pid)` | SIGTERM only, and only for pids currently classified as AI processes |

Boot order matters: collectors start, then `loadEdition()` resolves free/Pro
**before** `server.listen` — a client connecting mid-load would cache a free
cast for the life of the page.

### HTTP endpoints

| Route | Returns |
|---|---|
| `GET /health` | Secret-free readiness JSON (`buildHealth`) — used by launchd and monitors |
| `GET /api/state` | Full state dump + event feed + roundtable registry (debug/integration surface) |
| `GET /api/roundtable/:id.md` | A finished or live debate rendered as a markdown decision record (`debateToMarkdown`); 404 for unknown ids |
| `GET /vendor/*` | xterm.js assets straight from node_modules |
| `GET /*` | `public/` static files, path-contained by `withinDir` |

### WebSocket protocol (`/ws`)

Handshake is Origin-gated (`isAllowedOrigin`): browsers exempt WebSockets from
the Same-Origin Policy, so loopback binding alone would let any open tab drive
`pty.create` — arbitrary local code execution. Only our own loopback origins
pass; a missing Origin (curl, native clients) passes because a browser always
sends one.

**Client → server**

| Message | Payload | Effect |
|---|---|---|
| `pty.create` | profile, cwd, projectId, cols, rows | Spawn a terminal, stamp presence |
| `pty.attach` | id | Subscribe this socket to a terminal, replay scrollback |
| `pty.input` | id, data | Keystrokes |
| `pty.resize` | id, cols, rows | Resize |
| `pty.kill` | id | Kill + forget |
| `chat.open` | sessionId, requestId, cols, rows | Resume a live agent's session in a PTY; answers with `chat.opened` |
| `watch` | file, agent | Tail a transcript (path-contained to session dirs) |
| `unwatch` | — | Stop tailing |
| `proc.kill` | pid | SIGTERM a tracked AI process |
| `rt.start` | topic, roomId, participants, model | Convene a roundtable |
| `rt.cancel` | id | Kill the debate's child processes mid-flight |

**Server → client**

| Message | When |
|---|---|
| `snapshot` | On connect — full state + feed |
| `update` | A collector refreshed one key (`{key, data}`) |
| `event` | Feed item (spawn/exit/kill/up/down) |
| `cast` | On connect — public cast (prompts stripped), edition info, per-turn cost estimate, launchable `runtimes` and roundtable `models` from config |
| `rt.list` | On connect — live + recent debates |
| `rt.update` / `rt.turn` / `rt.speaking` / `rt.done` | Debate lifecycle |
| `pty.list` / `pty.attach` / `pty.data` / `pty.exit` | Terminal lifecycle |
| `chat.opened` | Answers `chat.open` with the pty id + requestId (the client must type into *that* pty, not the active tab) |
| `transcript` | Tail chunk (`{file, reset, events}`) |
| `error` | The last client message threw; also unwedges a pending chat composer |

---

## 2. Core modules — `src/`

### `state.js` — the store
| Export | Does |
|---|---|
| `State#update(key, value, broadcastValue?)` | Set + broadcast (optionally a lighter payload than stored) |
| `State#event(item)` | Append to the 200-item feed ring + broadcast |
| `State#snapshot()` | Full state for a new connection |
| `State#broadcast(msg)` | JSON to every open client |

### `pty.js` — terminals
One-keystroke launch profiles inside an interactive login zsh so agent CLIs
inherit the machine's credentials. `CLAUDE*` env vars are stripped so a spawned
`claude` doesn't think it's nested. The profile set is the built-ins plus any
`runtimes` from config, resolved at spawn time (`commandFor`) so a config edit
applies to the next terminal rather than the next boot.
| Export | Does |
|---|---|
| `PtyManager#create(profile, cwd, cols, rows, command?)` | Spawn; `command` is server-built only (chat resume), never raw client text |
| `#attach / #detachAll / #input / #resize / #kill / #list / #broadcastList` | Lifecycle; 200KB scrollback replayed on attach |

### `paths.js` — data home
Writes go to `~/.quorum`; reads also check the pre-rename
`~/.unified-ai-operator` so nothing (presence, paid-for debate archives) is
stranded. `dataDir()`, `readDirs()`, `findFile()`.

### `config.js` — user configuration
`~/.quorum/config.json`, read fresh on every catalog refresh so edits apply
without a restart. `loadConfig()`, `defaultRoots()` (~/CLAUDE, ~/code, ~/dev, …,
falling back to $HOME), `discoverProjects(roots)` (marker files: .git,
package.json, CLAUDE.md, wrangler.toml, Cargo.toml, pyproject.toml, go.mod,
Makefile, .claude), `slug()`.

Also owns the pluggable surfaces: `BUILTIN_RUNTIMES` / `loadRuntimes()` (agent
CLIs — built-ins plus config entries, built-in ids not overridable so a config
cannot silently rebind `claude` to another binary) and `BUILTIN_MODELS` /
`loadModels()` (roundtable model choices). Both cross to the browser in the
`cast` frame; the client renders its buttons and pickers from them rather than
from any hardcoded list, which is the entire "integrate any agent" mechanism.

### `validate.js` — the gate for machine-written configuration
Everything Quorum did not hand-write passes through here: the bootstrap's
proposal and Pro's custom personas. Each validator returns
`{ ok, value, errors }` and never throws — a bad generated file must degrade to
"rejected, with reasons", never take the cockpit down or half-apply.

| Export | Guards |
|---|---|
| `validateConfig(raw)` | Whole-file shape; reports each malformed section separately so the author can find it; one bad runtime invalidates the whole config rather than slipping through beside valid ones |
| `validateRuntime(r)` | **Security-critical.** The command is executed via `zsh -lic <cmd>`, so it must be a bare program name or absolute path — no arguments, no `; && \| $() \`\` > & ~ *` or newlines. This is the line between "add your own agent" and "config file runs arbitrary shell" |
| `validatePersona(raw)` | Palette values regex-checked as hex because they are interpolated into SVG attributes; prompts under 80 chars refused (too short to argue) |

### `util.js`
`sh()` (execFile→stdout, '' on error), `tailBytes()`, `withinDir()` (separator-
boundary containment), `isAllowedOrigin()`, `jsonLines()` (defensive JSONL).

### `health.js`
`buildHealth(stateData, {startedAt})` → status/uptime/services/sessions/projects.

### `presence.js`
`stampPresence()` / `loadPresence()` — seat records in `~/.quorum/presence.json`
(projectId, agent, ptyId, cwd, ts — never secrets), 40-entry ring.

---

## 3. The cast and editions

### `cast.js` — free crew + registry
| Export | Does |
|---|---|
| `FREE_CAST` | Nib (moderator), Vex (architect), Bolt (builder) — full personas |
| `MODERATOR_ID` | `'nib'` — structural, never seatable |
| `registerCast(members)` | Boot-time registration for Pro/custom; refuses to overwrite an existing id (an archived debate must re-read the same way months later) |
| `cast()` / `debaters()` / `castMember(id)` | Live registry views |
| `publicCast(locked?)` | Client-safe: strips `prompt` (the IP), appends locked members flagged `locked: true` |

### `cast-locked.js` — Pro appearance (ships publicly)
`LOCKED_CAST`: Sable, Muse, Ledger — palette/visor/crest/prop/tagline, **no
prompts**. Public on purpose: a greyed-out Sable with "paid to find the way it
breaks" sells the upgrade better than an absence nobody notices. Also the
single source of truth for Pro appearance — `cast-pro.js` imports it.

### `cast-pro.js` — **PRIVATE REPO ONLY**
The Pro personas. `PRO_CAST` = `LOCKED_CAST` + prompts. Excluded by
`build-open-core.mjs` (which fails the build if it leaks) and by the public
repo's `.gitignore`.

### `licence.js` — offline verification
Ed25519 over `canonicalPayload()` (field order pinned so a licence that
verifies on the seller's machine can't fail on the buyer's). `verifyLicence()`
(never throws — degrades to free with a reason), `isExpired()` (expiry gates
updates, not the software; unparseable dates count as perpetual because locking
a paying customer out over a typo is the worse failure), `readLicence()`,
`publicLicenceInfo()` (never the signature or email). Public key baked in;
private key at `~/.quorum/keys/`, in no repository.

### `edition.js` — resolution
`loadEdition()`: verify licence → dynamic-import `cast-pro.js` (absence is the
expected path in open-core) → `loadCustomCast()` from `~/.quorum/cast/*.json`
(Pro only; palette values regex-validated because they land in SVG attributes).
`editionInfo()` (tier, reason, locked list for the UI), `isPro()`.

---

## 4. The roundtable — `src/roundtable.js`

The debate protocol. Three properties make it produce disagreement instead of
a chorus: openings are generated **in parallel, mutually blind**; the clash
phase forces each participant to **name** the strongest counter and rebut or
concede explicitly; `position`/`confidence` are kept per phase so movement is
observable.

| Export | Does |
|---|---|
| `turnArgs()` (internal) | The `claude -p` argv: `--output-format json`, persona as system prompt, `--max-turns 1`, `--strict-mcp-config` + empty MCP, all tools disallowed (cost ~$0.08/turn vs ~$0.27 with the toolset; and a debater with Edit could rewrite the code it argues about) |
| `parseTurn(text)` | Schema-tolerant: fenced JSON, prose-wrapped JSON, or plain text all survive (a turn that ignored the schema still cost money); confidence clamped 0–100 |
| `Roundtable` | One debate: `run()` → brief → opening → clash → converge → verdict; `cancel()` SIGTERMs live children; `snapshot()`; `persist()` to `~/.quorum/roundtables/<id>.json` |
| `Roundtable.turnCount(n)` | `1 + 3n + 1` — the pre-flight estimate |
| `RoundtableRegistry` | One live debate per room (two tables on one question is duplicate spend); 20-deep recent list; `loadArchive()` reads both data homes |
| `EST_COST_PER_TURN_USD` | 0.08 — measured, used only for the pre-spend warning; real cost comes from the CLI's `total_cost_usd` |

Turn subprocesses run in the **room's cwd** so the project's own CLAUDE.md is
context — the debate argues about *this* codebase. `CLAUDE*` env stripped.

### `decision-record.js`
`debateToMarkdown(d)` → ADR-shaped export: Decision (the verdict) → Movement
table (confidence deltas; the evidence the debate did work) → "Where each
specialist landed" (deliberately *not* titled "surviving dissent" — a room can
converge from three directions, and calling agreement dissent misreports it;
that judgement belongs to the moderator's verdict) → full transcript. Pipes and
newlines escaped so positions can't break the table.

---

## 5. Collectors — `src/collectors/`

All follow the same contract: never throw (a collector dying silently blanks a
panel), cache by mtime+size, write via `state.update(key, …)`.

| File | Key | Source | Tick |
|---|---|---|---|
| `processes.js` | `processes` | `ps` classify+diff → groups, top-RSS, spawn/exit events | 2.5s |
| `sessions.js` | `sessions` | `~/.claude/projects/**/*.jsonl` + `~/.codex/sessions/**` (48h window, 90s activity threshold); also exports `TranscriptWatcher` (path-contained tailing, 1s poll) and the claude/codex event parsers | 3s |
| `services.js` | `services` | Hermes `:8644/health`, ComfyUI `:8188`, auth-file freshness (read-only, never tokens) | 5s |
| `system.js` | `system` | `vm_stat` + swap → memory pressure history | 2s |
| `projects.js` | `projects` | Catalog (config → legacy → discovered → catch-alls) × sessions → rooms with seated agents; `resolveProjectId` is longest-prefix; `configInfo()` rides the payload for the setup card | 2s render, 30s catalog refresh |
| `tasks.js` | `tasks` | `~/.claude/tasks/<sessionId>/*.json` joined to the session index; open + 15 recent-done, capped 200 | 3s |
| `composio.js` | `composio` | `~/.composio` files (5s) + `composio connections list` under explicit timeout (60s); key **fingerprint** only; flags multi-account toolkits (the `--account` footgun) | 5s/60s |
| `agents.js` | `agents` | `~/.claude/sessions/*.json` live registry, PID-liveness-checked — what makes an avatar sit still instead of vanishing between ticks | 2s |

---

## 6. Frontend — `public/` (no framework, no build step)

### `app.js`
One websocket, targeted renders. Message handlers mirror the protocol table
above. Key structures:

| Area | Functions |
|---|---|
| Views | `setView` over a `VIEWS` map (office/table/deck/board/radar); `?view=` beats localStorage |
| Studio | `renderOffice` (rooms as stages, drop targets), `renderCrew` (drag sources, seat toggles, Pro locks), `renderAvatars` (characters keyed by sessionId hash — stable faces; feet on `ROOM_FLOOR`), `castFor`, `setupCard` (empty floor teaches config), `wireRoomDrop` (namespaced payloads: `runtime:` spawns a PTY, `cast:` seats a debater) |
| Roundtable | `renderRoundtable`/`renderStage` (elliptical seating, speech bubbles, thinking dots)/`renderPhaseRail`/`renderMovement`/`renderLog`/`renderArchive` (+ per-row `.md` export)/`renderCastPicker`/`renderEstimate` (exact turn count × measured rate × model multiplier)/`showUpgrade` |
| Chat | `selectChat`, composer with pending-guard (a second submit would race two `claude --resume` against one transcript), `chat.opened` targets the answered pty id — **not** `S.activeTerm`, which may be a raw zsh that would execute the message |
| Terminals | `ensureTerm`/`activateTerm`/`fitTerm`/`syncTabs`/`renderTabs`; drawer collapses when empty (260px reclaimed) |
| Board | `renderBoard` + `openSessionById` (task card → live transcript) |
| Radar | `renderSessions`/`selectSession`/`evNode`, `renderSystem` (canvas charts), `renderServices`/`renderProcs`/`renderFeed` |
| Deck | Beau's CSS-3D command room (nodes, orbit, pressure, PTY seating) |
| Edition | `renderEdition` (FREE/PRO badge), locked-seat pruning on cast refresh |
| Tour | `TOUR` (7 steps pinned to live elements), `tourStart/Show/End`; auto-runs on first visit, `?` replays, Esc/arrows navigate |

### `art.js`
Hand-authored SVG. One silhouette; identity = palette + visor + crest + prop.
`drawCharacter(member, {size, state})` with size-gated detail (crest at every
size — it's the only silhouette differentiator; hands/props only above bust),
`drawMascot`, `drawRoom(mode)` (no `<defs>` — repeated gradient ids are invalid;
`ROOM_FLOOR` shared with the avatar layer so feet stay on the floor line), `LOD`.

### `style.css`
Token palette (amber accent = selection; green = alive; cyan = streaming — one
meaning per colour), Studio/Roundtable/Deck/Board/Radar layouts, character
animation (staggered float, reduced-motion respected), tour overlay (the dimmer
is the ring's 9999px box-shadow so the target stays at full brightness).

---

## 7. Seller tooling — `scripts/` (**PRIVATE REPO ONLY**)

| File | Does |
|---|---|
| `issue-licence.mjs` | Signs a licence with the key at `~/.quorum/keys/` (in no repo); stdout-composable for fulfilment |
| `install.sh` *(public)* | The one-line installer. Preflights node/git/claude, clones or fast-forwards `~/.quorum/app`, installs, then runs check + tests — an installer that says "done" without checking has only moved the failure to first run |
| `bootstrap.mjs` *(public)* | Proposes a config from machine evidence (see below). Dry-run by default; `--apply` backs up, writes, re-validates from disk, then runs the suite |
| `build-open-core.mjs` | Produces the public tree from an **allow-list** (nothing ships unless named), appends gitignore guards, then scans its own output and exits 1 if a Pro file is present |

## 7b. Bootstrap — configuration from evidence

`npm run bootstrap` asks a model to propose a Quorum setup from how the machine
is actually used, then routes the answer through the same validator a
hand-written config passes.

**What it sends.** Not transcripts. Derived signal only: which directories
sessions have run in and how often (counted from `~/.claude/projects/*`
directory names, which encode the cwd), which agent CLIs resolve on PATH, and
the headings plus project-table rows of a workspace `CLAUDE.md`. That is enough
to name and rank rooms without shipping private conversation content to an API
call.

**Why it is a dry run by default.** It writes the file that decides what the
product shows. A generated config silently replacing a hand-tuned one is a
data-loss bug wearing a feature's clothes. The flow is: propose → validate →
print → (with `--apply`) back up → write → re-read and re-validate from disk →
run `npm test`. An auto-adjustment that is not verified is just an unreviewed
commit.

## 8. Data on disk

| Path | What | Written by |
|---|---|---|
| `~/.quorum/config.json` | roots / explicit projects / hidden rooms | the user |
| `~/.quorum/licence.json` | signed Pro licence | Gumroad fulfilment |
| `~/.quorum/cast/*.json` | custom personas (Pro) | the user |
| `~/.quorum/presence.json` | seat stamps | `presence.js` |
| `~/.quorum/roundtables/*.json` | debate archive | `roundtable.js` |
| `~/.quorum/keys/` | licence signing keys | seller only, never in git |
| `~/.unified-ai-operator/` | pre-rename home — read, never written | legacy |

## 9. Tests — `test/`

| File | Covers |
|---|---|
| `roundtable.test.mjs` | parseTurn tolerance, seat validation, registry dedup, cancel idempotence, cast registry, prompt-leak guards |
| `licence.test.mjs` | wrong-key rejection, tamper detection, expiry semantics, info redaction |
| `decision-record.test.mjs` | verdict-first layout, movement math, markdown escaping, malformed-input safety |
| `config.test.mjs` | discovery markers/skips/labels, slug, cwd resolution vs catch-alls |
| `validate.test.mjs` | The generated-config gate: shell-injection attempts in runtime commands, built-in shadowing, per-section error reporting, SVG-injection in palettes, non-throwing on hostile input |
| `projects.test.mjs` | legacy id resolution, office seating |
| `chat-send.test.mjs` | the chat-pty targeting bug class (extracts live source; keep the section markers it slices on) |
| `health.test.mjs`, `util.test.mjs`, `deck.test.mjs` | health contract, origin/containment, Deck wiring |

`npm run check` = syntax sweep over every file above. CI runs `npm ci` + check.
