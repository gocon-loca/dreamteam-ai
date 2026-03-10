#!/bin/bash
# Install DreamTeam Supervisor as a macOS launchd service
#
# This will make the system start automatically on login
# and keep running 24/7.
#
# Works on any machine — generates plist dynamically from $HOME/$USER.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PLIST_NAME="com.dreamteam.keepalive.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_NAME"

echo "DreamTeam Supervisor Installation"
echo ""
echo "Project: $PROJECT_ROOT"
echo "User:    $USER"
echo "Home:    $HOME"
echo ""

# Build TypeScript first
echo "Building TypeScript..."
cd "$PROJECT_ROOT"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
pnpm build

# Verify supervisor was built
if [ ! -f "$PROJECT_ROOT/dist/daemon/supervisor.js" ]; then
    echo "Error: supervisor.js not built"
    exit 1
fi

# Create LaunchAgents directory if needed
mkdir -p "$HOME/Library/LaunchAgents"

# Stop existing service if running
if launchctl list 2>/dev/null | grep -q "com.dreamteam.keepalive"; then
    echo "Stopping existing service..."
    launchctl unload "$PLIST_DST" 2>/dev/null || true
fi

# Generate plist dynamically with correct paths for this machine
echo "Generating launchd plist for $USER@$(hostname)..."
cat > "$PLIST_DST" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.dreamteam.keepalive</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${PROJECT_ROOT}/scripts/keepalive.sh</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
        <key>Crashed</key>
        <true/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>WorkingDirectory</key>
    <string>${PROJECT_ROOT}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${HOME}/.local/bin:${HOME}/homebrew/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>${HOME}</string>
    </dict>

    <key>StandardOutPath</key>
    <string>/tmp/dreamteam-keepalive-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/dreamteam-keepalive-stderr.log</string>

    <key>ProcessType</key>
    <string>Interactive</string>

    <key>LimitLoadToSessionType</key>
    <array>
        <string>Aqua</string>
        <string>Background</string>
        <string>StandardIO</string>
    </array>
</dict>
</plist>
PLIST_EOF

# Validate plist
if ! plutil -lint "$PLIST_DST" > /dev/null 2>&1; then
    echo "Error: Generated plist is invalid"
    exit 1
fi

# Load the service
echo "Loading service..."
launchctl load "$PLIST_DST"

# Wait a moment
sleep 3

# Check if running
if launchctl list 2>/dev/null | grep -q "com.dreamteam.keepalive"; then
    echo ""
    echo "DreamTeam Supervisor installed and running!"
    echo ""
    echo "Commands:"
    echo "  Status:   ./scripts/supervisor-status.sh"
    echo "  Logs:     tail -f /tmp/dreamteam-keepalive.log"
    echo "  Stop:     launchctl unload $PLIST_DST"
    echo "  Start:    launchctl load $PLIST_DST"
    echo "  Uninstall: ./scripts/uninstall-supervisor.sh"
    echo ""
else
    echo "Service loaded but may not be running. Check logs:"
    echo "    tail /tmp/dreamteam-keepalive-stderr.log"
fi
