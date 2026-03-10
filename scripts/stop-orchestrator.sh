#!/bin/bash
# Stop the orchestrator daemon

PID=$(pgrep -f "orchestrator-daemon")

if [ -z "$PID" ]; then
  echo "Orchestrator daemon is not running"
  exit 0
fi

echo "Stopping orchestrator daemon (PID: $PID)..."
kill $PID

# Wait for graceful shutdown
sleep 2

if pgrep -f "orchestrator-daemon" > /dev/null; then
  echo "Force killing..."
  pkill -9 -f "orchestrator-daemon"
fi

echo "✅ Orchestrator daemon stopped"
