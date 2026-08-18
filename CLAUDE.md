# CLAUDE.md — unified-ai-operator

Local-first **cockpit** for AI activity on this machine (sessions, processes, Hermes,
ComfyUI, PTYs). Product entrypoint is the Node server on **127.0.0.1:4747**.

Own repo (gitignored from the superproject). Workspace rules — Definition of Done,
no-delete: **`../CLAUDE.md`**.

## Footguns

- **Loopback only.** `server.listen` must stay on `127.0.0.1`. This process spawns
  interactive shells; binding beyond localhost is a security incident.
- **Kill is restricted.** `proc.kill` may SIGTERM only pids currently in the tracked AI
  process list — never arbitrary pids.
- **No secrets in UI or logs.** Auth collectors report freshness only; never echo tokens.
- **Phase-0 Rust/Tauri is quarantined** under `archive/phase0-coordinator/`. Do not
  revive it as the primary product path. Steal lease/recovery ideas into this Node
  cockpit when needed (see `docs/product-backlog.md`).
- **Nothing gets deleted.** Archive or quarantine and report.
- **Roundtable turns spend the user's money.** Every debate turn is a real
  `claude -p` process. Never add a code path that starts a debate without a
  visible turn count and cost estimate first, and never remove the cancel path —
  `Roundtable.cancel()` must keep killing live child processes.
- **Debaters get no tools.** Turns run with tools and MCP stripped
  (`turnArgs` in `src/roundtable.js`). Re-enabling them would let an agent edit
  the code it is arguing about, and roughly triples the per-turn token cost.
- **Personas never reach the browser.** `publicCast()` strips `prompt`; the
  personas are the product's IP. There is a test asserting this.
- **This repo is the PRIVATE Pro repo.** `src/cast-pro.js`, `scripts/issue-licence.mjs`
  and `docs/pro/` must never reach the public `quorum` repo. The public tree is
  produced by `node scripts/build-open-core.mjs`, which uses an allow-list and
  fails the build if a Pro file appears in the output. Never publish this repo's
  history — the Pro personas are in it.
- **The licence signing key is not in git and never will be.** It lives at
  `~/.quorum/keys/quorum-licence-private.pem`; the matching public key is baked
  into `src/licence.js`. Rotating it invalidates every licence already sold.
- **A failed licence check degrades to free, never crashes.** Locking a paying
  customer out of software running on their own machine is the worse failure.

## Commands

```bash
npm start            # → http://127.0.0.1:4747
npm run check        # node --check sweep
npm install          # deps + node-pty spawn-helper chmod
```

Optional Phase-0 archive (not required for the product):

```bash
cd archive/phase0-coordinator && cargo test --workspace
```

## Layout

| Path | Owns |
|---|---|
| `server.js` | HTTP + WebSocket, static, kill gate, roundtable routes |
| `src/collectors/` | processes, sessions, services, system |
| `src/pty.js` | node-pty terminal manager |
| `src/state.js` | in-memory store + WS broadcast |
| `src/cast.js` | the crew — palettes (public) + personas (server-only) |
| `src/roundtable.js` | debate protocol, turn execution, cost, cancellation |
| `src/decision-record.js` | finished debate → markdown ADR |
| `public/art.js` | character + room SVG art |
| `public/` | SPA (no build step) |
| `docs/product-backlog.md` | Near-term productization backlog |
| `docs/product-plan.md` | Positioning, pricing and launch plan for selling this |
| `archive/phase0-coordinator/` | Quarantined Rust coordinator + Tauri shell |

CI runs `npm ci` + `npm run check` on the cockpit. Phase-0 cargo CI is intentionally
not the default gate anymore.
