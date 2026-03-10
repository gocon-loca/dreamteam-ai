#!/bin/bash
# Stop the overnight daemon

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$PROJECT_DIR/data/overnight.pid"

if [ ! -f "$PID_FILE" ]; then
    echo "No PID file found. Daemon may not be running."
    exit 0
fi

PID=$(cat "$PID_FILE")

if ps -p "$PID" > /dev/null 2>&1; then
    echo "Stopping overnight daemon (PID: $PID)..."
    kill "$PID"
    sleep 2

    if ps -p "$PID" > /dev/null 2>&1; then
        echo "Daemon didn't stop gracefully. Force killing..."
        kill -9 "$PID"
    fi

    echo "✅ Daemon stopped"
else
    echo "Daemon was not running (stale PID file)"
fi

rm -f "$PID_FILE"
