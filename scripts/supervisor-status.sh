#!/bin/bash
# Check status of the DreamTeam Supervisor system

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

echo "═══════════════════════════════════════════════════════════"
echo "  DreamTeam Supervisor Status"
echo "═══════════════════════════════════════════════════════════"
echo ""

# Colors (if supported)
if [ -t 1 ]; then
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    RED='\033[0;31m'
    NC='\033[0m' # No Color
else
    GREEN=''
    YELLOW=''
    RED=''
    NC=''
fi

# Helper to check process
check_process() {
    local pattern="$1"
    local name="$2"
    local pid_file="$3"

    local status="${RED}NOT RUNNING${NC}"
    local pid=""

    # Check PID file first
    if [ -n "$pid_file" ] && [ -f "$pid_file" ]; then
        pid=$(cat "$pid_file")
        if ps -p "$pid" > /dev/null 2>&1; then
            status="${GREEN}RUNNING${NC}"
            local uptime=$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ')
            echo -e "  $name: $status (PID: $pid, Uptime: $uptime)"
            return 0
        fi
    fi

    # Check by process pattern
    pid=$(pgrep -f "$pattern" 2>/dev/null | head -1)
    if [ -n "$pid" ]; then
        status="${GREEN}RUNNING${NC}"
        local uptime=$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ')
        echo -e "  $name: $status (PID: $pid, Uptime: $uptime)"
        return 0
    fi

    echo -e "  $name: $status"
    return 1
}

echo "📊 Process Status:"
echo ""
check_process "keepalive.sh" "Keepalive Script" ""
check_process "supervisor.js" "Supervisor Daemon" "$PROJECT_ROOT/data/supervisor.pid"
check_process "overnight.js" "Overnight Daemon" "$PROJECT_ROOT/data/overnight.pid"
check_process "orchestrator-daemon" "Orchestrator" ""
echo ""

# Claude agents
agent_count=$(pgrep -f "claude.*print" 2>/dev/null | wc -l | tr -d ' ')
if [ "$agent_count" -gt "0" ]; then
    echo -e "  Claude Agents: ${GREEN}$agent_count running${NC}"
else
    echo -e "  Claude Agents: ${YELLOW}0 running${NC}"
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  launchd Service"
echo "═══════════════════════════════════════════════════════════"
echo ""

if launchctl list | grep -q "com.dreamteam.keepalive"; then
    echo -e "  Service: ${GREEN}LOADED${NC}"
    launchctl list com.dreamteam.keepalive 2>/dev/null | head -5
else
    echo -e "  Service: ${YELLOW}NOT LOADED${NC}"
    echo "  Install with: ./scripts/install-supervisor.sh"
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Supervisor State"
echo "═══════════════════════════════════════════════════════════"
echo ""

STATE_FILE="$PROJECT_ROOT/data/supervisor-state.json"
if [ -f "$STATE_FILE" ]; then
    cat "$STATE_FILE" | python3 -m json.tool 2>/dev/null || cat "$STATE_FILE"
else
    echo "  No state file found (supervisor may not have started yet)"
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Recent Logs"
echo "═══════════════════════════════════════════════════════════"
echo ""

LOG_FILE="$PROJECT_ROOT/logs/supervisor-$(date +%Y-%m-%d).log"
if [ -f "$LOG_FILE" ]; then
    echo "  Last 10 lines from $LOG_FILE:"
    echo ""
    tail -10 "$LOG_FILE" | sed 's/^/  /'
else
    echo "  No logs for today yet"
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Commands"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "  Follow logs:     tail -f $PROJECT_ROOT/logs/supervisor*.log"
echo "  Restart:         ./scripts/uninstall-supervisor.sh && ./scripts/install-supervisor.sh"
echo "  Stop:            launchctl unload ~/Library/LaunchAgents/com.dreamteam.keepalive.plist"
echo ""
