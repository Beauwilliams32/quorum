# CLAUDE.md — quorum

Local-first cockpit + AI roundtable. Product entrypoint is the Node server on
**127.0.0.1:4747**. No build step; `public/` is served as-is.

## Footguns

- **Loopback only.** `server.listen` must stay on `127.0.0.1`. This process
  spawns interactive shells; binding beyond localhost is a security incident.
- **The websocket handshake is Origin-gated** (`isAllowedOrigin`). Browsers
  exempt WebSockets from the Same-Origin Policy, so loopback alone is not a
  boundary — do not weaken this check.
- **Kill is restricted.** `proc.kill` may SIGTERM only pids in the tracked AI
  process list — never arbitrary pids.
- **Roundtable turns spend the user's money.** Never add a code path that starts
  a debate without a visible turn count and cost estimate, and never remove the
  cancel path — `Roundtable.cancel()` must keep killing live child processes.
- **Debaters get no tools.** Turns run with tools and MCP stripped (`turnArgs`
  in `src/roundtable.js`). Re-enabling them lets an agent edit the code it is
  arguing about, and roughly triples per-turn cost.
- **Personas never reach the browser.** `publicCast()` strips `prompt`;
  there is a test asserting this.
- **No secrets in UI or logs.** Collectors report freshness only.

## Commands

```sh
npm start            # → http://127.0.0.1:4747
npm run check        # node --check sweep — the pre-commit gate
npm test             # node --test test/*.test.mjs
```

## Public boundary

The public tree contains only runtime-critical cockpit code, tests, install
documentation, and safe open-core contracts. Internal architecture, backlog,
Pro personas, licence tooling, and private runtime source are excluded.
