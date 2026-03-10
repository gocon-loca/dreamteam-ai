#!/bin/bash
# Start the full DreamTeam system with redundancy
#
# Runs both:
# 1. Orchestrator daemon (smart coordinator - responds to user, helps agents)
# 2. Overnight daemon (dumb worker - keeps projects moving even if orchestrator hangs)
#
# Project agents will try to communicate with orchestrator, but fall back
# to autonomous mode if no response within timeout.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOGS_DIR="$PROJECT_DIR/logs"

mkdir -p "$LOGS_DIR"

echo "🚀 Starting DreamTeam with redundancy..."
echo ""

# Build first
echo "📦 Building..."
cd "$PROJECT_DIR" && pnpm build

# Start orchestrator daemon (smart coordinator)
if pgrep -f "orchestrator-daemon" > /dev/null; then
  echo "✅ Orchestrator daemon already running"
else
  echo "🤖 Starting orchestrator daemon..."
  nohup node dist/daemon/orchestrator-daemon.js >> "$LOGS_DIR/orchestrator.log" 2>&1 &
  echo "   PID: $!"
fi

# Start overnight daemon (dumb worker fallback)
if pgrep -f "overnight.js" > /dev/null; then
  echo "✅ Overnight daemon already running"
else
  echo "🌙 Starting overnight daemon (fallback)..."
  nohup node dist/daemon/overnight.js >> "$LOGS_DIR/overnight.log" 2>&1 &
  echo "   PID: $!"
fi

# Start bot if not running
if pgrep -f "bot/index.js" > /dev/null; then
  echo "✅ Telegram bot already running"
else
  echo "📱 Starting Telegram bot..."
  nohup node dist/bot/index.js >> "$LOGS_DIR/bot.log" 2>&1 &
  echo "   PID: $!"
fi

sleep 2

echo ""
echo "✅ All systems started!"
echo ""
echo "📊 Status:"
pgrep -f "orchestrator-daemon" > /dev/null && echo "   🤖 Orchestrator: RUNNING" || echo "   🤖 Orchestrator: STOPPED"
pgrep -f "overnight.js" > /dev/null && echo "   🌙 Overnight: RUNNING" || echo "   🌙 Overnight: STOPPED"
pgrep -f "bot/index.js" > /dev/null && echo "   📱 Bot: RUNNING" || echo "   📱 Bot: STOPPED"
echo ""
echo "📝 Logs:"
echo "   tail -f $LOGS_DIR/orchestrator.log"
echo "   tail -f $LOGS_DIR/overnight.log"
echo "   tail -f $LOGS_DIR/bot.log"
echo ""
echo "🛑 To stop: ./scripts/stop-all.sh"
