#!/bin/bash
# Start the overnight daemon as a detached background process
# This survives terminal disconnects and runs all night

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOGS_DIR="$PROJECT_DIR/logs"
PID_FILE="$PROJECT_DIR/data/overnight.pid"

mkdir -p "$LOGS_DIR"
mkdir -p "$PROJECT_DIR/data"

# Check if already running
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if ps -p "$OLD_PID" > /dev/null 2>&1; then
        echo "Overnight daemon already running (PID: $OLD_PID)"
        echo "Use ./scripts/stop-overnight.sh to stop it first"
        exit 1
    fi
fi

echo "Starting overnight daemon..."
cd "$PROJECT_DIR"

# Start with nohup so it survives terminal disconnect
nohup node dist/daemon/overnight.js >> "$LOGS_DIR/overnight.log" 2>&1 &
NEW_PID=$!
echo $NEW_PID > "$PID_FILE"

echo "✅ Overnight daemon started (PID: $NEW_PID)"
echo "📝 Logs: $LOGS_DIR/overnight.log"
echo ""
echo "Commands:"
echo "  tail -f $LOGS_DIR/overnight.log    # Follow logs"
echo "  ./scripts/stop-overnight.sh        # Stop daemon"
echo "  ./scripts/status-overnight.sh      # Check status"
