#!/bin/sh
set -eu

# Resolve the gateway SecretRef at launch time without persisting or logging its value.
# Quorum receives only the environment-reference name; the token remains in OpenClaw's store.
# OpenClaw intentionally requires an interactive terminal for token reveal; use a
# throwaway PTY whose transcript is discarded, then keep the value process-local.
token=''
while IFS= read -r line; do
  line=${line%"$(printf '\r')"}
  case "$line" in
    ''|Script\ started*|Script\ done*) ;;
    *) token="$line" ;;
  esac
done <<EOF
$(script -q /dev/null /bin/sh -c 'openclaw gateway auth-token --show' 2>/dev/null)
EOF
if [ -z "$token" ]; then
  printf '%s\n' 'Quorum OpenClaw auth reference could not be resolved' >&2
  exit 78
fi
export OPENCLAW_GATEWAY_TOKEN="$token"
export QUORUM_OPENCLAW_TOKEN_ENV=OPENCLAW_GATEWAY_TOKEN
exec "$@"
