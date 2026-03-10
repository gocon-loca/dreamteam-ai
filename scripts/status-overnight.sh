#!/bin/bash
# Check status of the overnight daemon

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$PROJECT_DIR/data/overnight.pid"
STATE_FILE="$PROJECT_DIR/data/daemon-state.json"
LOGS_DIR="$PROJECT_DIR/logs"

echo "=== Overnight Daemon Status ==="
echo ""

# Check if running
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if ps -p "$PID" > /dev/null 2>&1; then
        echo "Status: 🟢 RUNNING (PID: $PID)"
        UPTIME=$(ps -o etime= -p "$PID" | tr -d ' ')
        echo "Uptime: $UPTIME"
    else
        echo "Status: 🔴 NOT RUNNING (stale PID)"
    fi
else
    echo "Status: ⚪ NOT STARTED"
fi

echo ""

# Show state if available
if [ -f "$STATE_FILE" ]; then
    echo "=== Daemon State ==="
    cat "$STATE_FILE" | python3 -m json.tool 2>/dev/null || cat "$STATE_FILE"
fi

echo ""
echo "=== Recent Logs ==="
LOG_FILE="$LOGS_DIR/overnight-$(date +%Y-%m-%d).log"
if [ -f "$LOG_FILE" ]; then
    tail -20 "$LOG_FILE"
else
    echo "No logs for today yet"
fi
