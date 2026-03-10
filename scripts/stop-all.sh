#!/bin/bash
# Stop all DreamTeam processes

echo "🛑 Stopping DreamTeam..."

pkill -f "orchestrator-daemon" 2>/dev/null && echo "   Stopped orchestrator daemon" || echo "   Orchestrator not running"
pkill -f "overnight.js" 2>/dev/null && echo "   Stopped overnight daemon" || echo "   Overnight not running"
pkill -f "bot/index.js" 2>/dev/null && echo "   Stopped bot" || echo "   Bot not running"

echo ""
echo "✅ All processes stopped"
