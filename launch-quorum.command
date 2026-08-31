#!/bin/bash
# Double-click launcher for Quorum (unified-ai-operator cockpit).
set -e

# Resolve to wherever this launcher actually lives, so the file works from any
# checkout (and can ship in the public repo) rather than only from one absolute
# path on one machine. Double-clicking still lands in the repo root as before.
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-4747}"
URL="http://127.0.0.1:${PORT}"
LOG_FILE="$HOME/Library/Logs/quorum.log"

cd "$PROJECT_DIR"

if ! curl -s -o /dev/null --max-time 1 "$URL"; then
  echo "Starting Quorum server..."
  nohup npm start >> "$LOG_FILE" 2>&1 &
  disown

  for i in $(seq 1 20); do
    if curl -s -o /dev/null --max-time 1 "$URL"; then
      break
    fi
    sleep 0.5
  done
else
  echo "Quorum is already running."
fi

open "$URL"
