#!/bin/bash
# Start the DreamTeam supervisor + worker system
#
# Architecture:
#   bot          — Telegram interface + Director
#   supervisor   — Queue manager, monitor, cost control
#   worker-0..2  — Executors, poll SQLite for work (3 workers, max 1/project)
#
# Re-runnable: checks PIDs before launching to avoid duplicates.
# Stores all managed PIDs in data/.dreamteam-pids for protection.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOGS_DIR="$PROJECT_DIR/logs"
DATA_DIR="$PROJECT_DIR/data"
PID_FILE="$DATA_DIR/.dreamteam-pids"
mkdir -p "$LOGS_DIR" "$DATA_DIR"

echo "Building..."
cd "$PROJECT_DIR" && pnpm build

# Check for configuration
if [ ! -f "$PROJECT_DIR/.env" ] && [ ! -f "$PROJECT_DIR/config/secrets.enc.yaml" ] && [ ! -f "$PROJECT_DIR/config/secrets.yaml" ]; then
  echo "ERROR: No configuration found!"
  echo "Run 'pnpm run setup:web' to configure DreamTeam first."
  exit 1
fi

# Helper: check if a PID is alive
is_alive() {
  kill -0 "$1" 2>/dev/null
}

# Helper: start a process if not already running
start_process() {
  local name="$1"
  local grep_pattern="$2"
  local command="$3"
  local log_file="$4"

  # Check by process name
  local existing_pid
  existing_pid=$(pgrep -f "$grep_pattern" | head -1)

  if [ -n "$existing_pid" ] && is_alive "$existing_pid"; then
    echo "$name: already running (PID $existing_pid)"
    echo "$existing_pid" >> "$PID_FILE"
    return
  fi

  nohup $command >> "$log_file" 2>&1 &
  local new_pid=$!
  echo "$name: PID $new_pid"
  echo "$new_pid" >> "$PID_FILE"
}

# Reset PID tracking file
> "$PID_FILE"

# Start core processes
# Start bot only if Telegram is configured
if grep -q "TELEGRAM_BOT_TOKEN" "$PROJECT_DIR/.env" 2>/dev/null || [ -f "$PROJECT_DIR/config/secrets.enc.yaml" ] || [ -f "$PROJECT_DIR/config/secrets.yaml" ]; then
  start_process "Bot" "bot/index.js" "node dist/bot/index.js" "$LOGS_DIR/bot.log"
else
  echo "Bot: Skipped (no Telegram token configured — use CLI: pnpm goal)"
fi
start_process "Supervisor" "daemon/supervisor.js" "node dist/daemon/supervisor.js" "$LOGS_DIR/supervisor.log"

# Start 6 workers (matches supervisor maxWorkers)
for i in 0 1 2 3 4 5; do
  start_process "Worker $i" "worker.js --id $i" "node dist/daemon/worker.js --id $i" "$LOGS_DIR/worker-$i.log"
done

sleep 2
echo ""
echo "All systems started. Managed PIDs:"
cat "$PID_FILE" | while read pid; do
  if is_alive "$pid"; then
    name=$(ps -p "$pid" -o args= 2>/dev/null | sed 's|.*/||' | head -c 40)
    echo "  $pid — $name"
  fi
done
echo ""
echo "PID file: $PID_FILE"
echo "IMPORTANT: Never kill processes listed in $PID_FILE"
