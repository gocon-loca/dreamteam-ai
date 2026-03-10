#!/bin/bash
# Start the orchestrator daemon

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOGS_DIR="$PROJECT_DIR/logs"

# Create logs directory if needed
mkdir -p "$LOGS_DIR"

# Check if already running
if pgrep -f "orchestrator-daemon" > /dev/null; then
  echo "Orchestrator daemon is already running"
  exit 0
fi

# Build first
echo "Building..."
cd "$PROJECT_DIR" && pnpm build

# Start daemon
echo "Starting orchestrator daemon..."
cd "$PROJECT_DIR"
nohup node dist/daemon/orchestrator-daemon.js >> "$LOGS_DIR/orchestrator.log" 2>&1 &

PID=$!
echo "✅ Orchestrator daemon started (PID: $PID)"
echo "📝 Logs: $LOGS_DIR/orchestrator.log"
echo ""
echo "Commands:"
echo "  tail -f $LOGS_DIR/orchestrator.log    # Follow logs"
echo "  ./scripts/stop-orchestrator.sh        # Stop daemon"
