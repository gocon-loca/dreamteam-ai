#!/bin/bash
# Uninstall DreamTeam Supervisor

set -e

PLIST_NAME="com.dreamteam.keepalive.plist"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME"

echo "🛑 Uninstalling DreamTeam Supervisor..."
echo ""

# Stop and unload the service
if launchctl list | grep -q "com.dreamteam.keepalive"; then
    echo "⏹️  Stopping service..."
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

# Kill any running processes
echo "🔪 Killing running processes..."
pkill -f "supervisor.js" 2>/dev/null || true
pkill -f "keepalive.sh" 2>/dev/null || true
pkill -f "overnight.js" 2>/dev/null || true
pkill -f "orchestrator-daemon" 2>/dev/null || true

# Remove plist
if [ -f "$PLIST_PATH" ]; then
    echo "🗑️  Removing launchd plist..."
    rm "$PLIST_PATH"
fi

echo ""
echo "✅ DreamTeam Supervisor uninstalled"
echo ""
echo "Note: PID files and logs were not removed."
echo "To clean everything: rm -rf data/*.pid logs/*.log"
