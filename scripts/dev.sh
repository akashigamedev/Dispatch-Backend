#!/usr/bin/env bash
# Boot ngrok + dev server together. Ctrl-C kills both.
set -euo pipefail

DOMAIN="nonirritably-premortuary-malisa.ngrok-free.dev"
PORT="${PORT:-3000}"

cleanup() {
  if [[ -n "${NGROK_PID:-}" ]]; then
    kill "$NGROK_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if curl -sf "https://$DOMAIN" -o /dev/null -m 2; then
  echo "→ tunnel already online: https://$DOMAIN (skipping ngrok start)"
else
  echo "→ ngrok http --url=$DOMAIN $PORT"
  ngrok http --url="$DOMAIN" "$PORT" --log=stdout --log-format=logfmt > /tmp/nightowl-ngrok.log 2>&1 &
  NGROK_PID=$!
  for i in {1..15}; do
    if curl -sf "https://$DOMAIN" -o /dev/null -m 2; then break; fi
    sleep 1
  done
  echo "→ tunnel: https://$DOMAIN  (logs: /tmp/nightowl-ngrok.log)"
fi
echo

cd "$(dirname "$0")/.."
exec npx tsx watch src/index.ts
