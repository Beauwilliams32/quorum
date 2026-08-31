#!/usr/bin/env bash
# Quorum installer.
#
#   curl -fsSL https://raw.githubusercontent.com/Beauwilliams32/quorum/main/scripts/install.sh | bash
#
# Clones (or updates) the open-core repo, installs dependencies, and prints how
# to start. Deliberately boring and inspectable: piping a script to bash asks a
# lot of trust, so this one does nothing clever, touches only ~/.quorum and the
# install directory, and never writes outside them.
set -euo pipefail

REPO="${QUORUM_REPO:-https://github.com/Beauwilliams32/quorum.git}"
DIR="${QUORUM_DIR:-$HOME/.quorum/app}"
PORT="${PORT:-4747}"

say()  { printf '\033[38;5;214m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

say "Quorum — the writers' room for your codebase"
echo

# ── preflight ───────────────────────────────────────────────────────────────
command -v git  >/dev/null 2>&1 || die "git is required"
command -v node >/dev/null 2>&1 || die "Node.js 20+ is required — https://nodejs.org"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js 20+ required (found $(node -v))"
info "node $(node -v)"

# The CLI is what actually runs debate turns. Missing it is not fatal — the
# cockpit still works — but saying so now beats a confusing empty roundtable.
if command -v claude >/dev/null 2>&1; then
  info "claude CLI found"
else
  info "claude CLI NOT found — the cockpit will run, but debates need it:"
  info "  https://claude.com/claude-code"
fi

# ── fetch ───────────────────────────────────────────────────────────────────
if [ -d "$DIR/.git" ]; then
  say "Updating $DIR"
  git -C "$DIR" pull --ff-only
else
  say "Cloning into $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone --depth 1 "$REPO" "$DIR"
fi

say "Installing dependencies"
( cd "$DIR" && npm install --no-audit --no-fund )

# ── verify ──────────────────────────────────────────────────────────────────
# An installer that says "done" without checking has just moved the failure to
# the user's first run.
say "Verifying"
( cd "$DIR" && npm run check >/dev/null ) && info "syntax check passed"
if ( cd "$DIR" && npm test >/dev/null 2>&1 ); then
  info "test suite passed"
else
  info "tests reported failures — run 'npm test' in $DIR"
fi

echo
say "Installed."
echo
info "Start it:    cd $DIR && npm start"
info "Then open:   http://127.0.0.1:$PORT"
echo
info "A guided tour starts on first launch. Projects are discovered"
info "automatically; override them in ~/.quorum/config.json."
