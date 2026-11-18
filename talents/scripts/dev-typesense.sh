#!/usr/bin/env bash
# Local DEV Typesense for Talents P1 — a plain binary process (no container).
#   scripts/dev-typesense.sh start|stop|status|health
# Binary + data live under .tools/ (gitignored). The API key is the labelled
# local dev default unless TALENTS_TYPESENSE_KEY is set in the environment.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS="$ROOT/.tools"
BIN="$TOOLS/typesense-server"
DATA_DIR="$TOOLS/typesense-data"
KEY="${TALENTS_TYPESENSE_KEY:-talents-dev-key-p1}"
ADDR="${TALENTS_TYPESENSE_ADDR:-127.0.0.1}"
PORT="${TALENTS_TYPESENSE_PORT:-8108}"

case "${1:-status}" in
  start)
    if curl -fs "http://$ADDR:$PORT/health" >/dev/null 2>&1; then
      echo "typesense already up on $ADDR:$PORT"; exit 0
    fi
    if [[ ! -x "$BIN" ]]; then
      echo "missing $BIN — download: curl -fsSL https://dl.typesense.org/releases/29.0/typesense-server-29.0-linux-amd64.tar.gz | tar xz -C $TOOLS" >&2
      exit 1
    fi
    mkdir -p "$DATA_DIR"
    nohup "$BIN" --data-dir="$DATA_DIR" --api-address="$ADDR" --api-port="$PORT" --api-key="$KEY" >"$TOOLS/typesense.log" 2>&1 &
    for i in $(seq 1 20); do
      curl -fs "http://$ADDR:$PORT/health" >/dev/null 2>&1 && { echo "typesense up: http://$ADDR:$PORT (log: $TOOLS/typesense.log)"; exit 0; }
      sleep 0.5
    done
    echo "typesense did not answer health in time — see $TOOLS/typesense.log" >&2; exit 1
    ;;
  stop)
    pkill -f "typesense-server.*--api-port=$PORT" && echo "typesense stopped" || echo "typesense not running"
    ;;
  health)
    curl -s "http://$ADDR:$PORT/health"; echo
    ;;
  status)
    if curl -fs "http://$ADDR:$PORT/health" >/dev/null 2>&1; then echo "up: http://$ADDR:$PORT"; else echo "down"; fi
    ;;
  *) echo "usage: $0 start|stop|status|health" >&2; exit 1 ;;
esac
