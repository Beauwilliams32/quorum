# Trident Command

Trident Command is a local-first portfolio and AI-operations cockpit for Trident Studio. It tracks project readiness, blockers, verification evidence, and next moves, then connects to the local Quorum runtime when it is available.

## What it does

- Portfolio view for all projects in motion
- Operator cockpit for Quorum and Unified AI Operator
- Local runtime connection to Quorum at `127.0.0.1:4747`
- Live model/harness catalog for Claude, Codex, OpenAI API, Gemini, Hermes, OpenClaw, ComfyUI/Wan, and custom adapters
- Guarded launch previews with explicit confirmation; credentials and prompts never enter the UI
- Deterministic pet avatars that work offline, with local-only replacement assets supported by Quorum
- Offline fallback so the portfolio still works when Quorum is not running
- No credentials, external APIs, or hosted database required

Quorum is the current product name for the project formerly called Unified AI Operator. Trident Command treats it as the local orchestration and runtime layer; it does not expose Quorum beyond loopback.

## Run locally

Requirements: Node.js 22.13 or newer.

```bash
npm install
npm run local
```

Open `http://localhost:3000`.

For live operator state, run Quorum separately from its own repository:

```bash
npm start
```

Quorum should be listening on `http://127.0.0.1:4747`. Without it, Trident Command remains usable with its truthful offline state.

When Quorum is available, the operator view reads its redacted catalog and
project rooms through the local bridge. Launch actions first request a preview
and then require explicit confirmation; the bridge never exposes the Quorum
WebSocket or forwards secrets.

## Development

```bash
npm run dev
npm run build
npm test
```

## Design boundary

Trident Command is an inspect-and-route surface. It does not silently start agents, publish projects, spend money, enable live trading, or bypass human review. Quorum debates are expected to produce decisions and dissent; the operator runtime remains local-only.

## License

MIT
