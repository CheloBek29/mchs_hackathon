#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"
mkdir -p "$RUN_DIR"

"$ROOT_DIR/scripts/stop-all.sh" >/dev/null 2>&1 || true

BACKEND_CMD=("$ROOT_DIR/backend/.venv-local/bin/uvicorn" "app.main:app" "--host" "0.0.0.0" "--port" "8000")
if [[ ! -x "${BACKEND_CMD[0]}" ]]; then
  BACKEND_CMD=("uvicorn" "app.main:app" "--host" "0.0.0.0" "--port" "8000")
fi

(
  cd "$ROOT_DIR/backend"
  nohup "${BACKEND_CMD[@]}" >"$RUN_DIR/backend.log" 2>&1 &
  echo $! >"$RUN_DIR/backend.pid"
)

(
  cd "$ROOT_DIR/frontend"
  nohup npm run dev -- --host 0.0.0.0 --port 5173 >"$RUN_DIR/frontend.log" 2>&1 &
  echo $! >"$RUN_DIR/frontend.pid"
)

(
  cd "$ROOT_DIR/radio 2"
  nohup npm start >"$RUN_DIR/radio.log" 2>&1 &
  echo $! >"$RUN_DIR/radio.pid"
)

echo "Started services:"
echo "- backend  : PID $(cat "$RUN_DIR/backend.pid") (http://localhost:8000)"
echo "- frontend : PID $(cat "$RUN_DIR/frontend.pid") (http://localhost:5173)"
echo "- radio    : PID $(cat "$RUN_DIR/radio.pid") (ws://localhost:8080/ws)"
