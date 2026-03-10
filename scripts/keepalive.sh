#!/bin/bash
# DreamTeam Keepalive - Monitors ALL processes and auto-restarts on crash
#
# Watches: bot, supervisor, workers (0-3), prototype server
# Sends Telegram notification when anything restarts.
#
# Usage:
#   Manual: ./scripts/keepalive.sh
#   Launchd: launchctl load ~/Library/LaunchAgents/com.dreamteam.keepalive.plist

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
LOG_FILE="/tmp/dreamteam-keepalive.log"
LOGS_DIR="$PROJECT_ROOT/logs"
DATA_DIR="$PROJECT_ROOT/data"
NUM_WORKERS=4

# Set up PATH for Homebrew (supports ~/homebrew and /opt/homebrew)
if [ -x "$HOME/homebrew/bin/brew" ]; then
    eval "$($HOME/homebrew/bin/brew shellenv)"
    export PATH="$HOME/homebrew/opt/node@22/bin:$PATH"
elif [ -x "/opt/homebrew/bin/brew" ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
fi
export PATH="$HOME/.local/bin:$PATH"

# Fix SSL cert validation for Homebrew-built Node
if [ -f "$HOME/homebrew/etc/ca-certificates/cert.pem" ]; then
    export NODE_EXTRA_CA_CERTS="$HOME/homebrew/etc/ca-certificates/cert.pem"
elif [ -f "/opt/homebrew/etc/ca-certificates/cert.pem" ]; then
    export NODE_EXTRA_CA_CERTS="/opt/homebrew/etc/ca-certificates/cert.pem"
fi

# Auto-unlock Keychain for Claude CLI OAuth tokens (needed after reboot)
KEYCHAIN_PW_FILE="$PROJECT_ROOT/config/keychain-password"
if [ -f "$KEYCHAIN_PW_FILE" ]; then
    security unlock-keychain -p "$(cat "$KEYCHAIN_PW_FILE")" ~/Library/Keychains/login.keychain-db 2>/dev/null && \
        echo "Keychain unlocked" || echo "Keychain unlock skipped (may already be unlocked)"
    security set-keychain-settings ~/Library/Keychains/login.keychain-db 2>/dev/null
fi

# ── Claude Code Review integration ────────────────────────────
# Use Claude Code Review for quality gate (full codebase context, no diff truncation)
export DREAMTEAM_REVIEW_BACKEND=claude-code
# Run both review backends for complex/auth goals (strictest verdict wins)
export DREAMTEAM_REVIEW_DUAL_GATE=1
# Create GitHub PRs with review findings for rejected goals
export DREAMTEAM_REVIEW_CREATE_PR=1

mkdir -p "$DATA_DIR" "$LOGS_DIR"

log() {
    local timestamp=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    echo "[$timestamp] $1" >> "$LOG_FILE"
    echo "[$timestamp] $1"
}

# Check if a process matching a grep pattern is alive
is_alive() {
    pgrep -f "$1" > /dev/null 2>&1
}

# Start a process if not running. Returns 0 if started, 1 if already running.
ensure_process() {
    local name="$1"
    local grep_pattern="$2"
    local command="$3"
    local log_file="$4"

    if is_alive "$grep_pattern"; then
        return 1  # Already running
    fi

    log "Starting $name..."
    cd "$PROJECT_ROOT"
    nohup $command >> "$log_file" 2>&1 &
    local pid=$!
    sleep 2

    if kill -0 "$pid" 2>/dev/null; then
        log "$name started (PID $pid)"
        echo "$name" # Return name of what was started
        return 0
    else
        log "ERROR: $name failed to start"
        return 0  # Still return 0 so we report the failure
    fi
}

# Send Telegram notification about crash recovery
send_crash_alert() {
    local restarted="$1"
    if [ -z "$restarted" ]; then return; fi

    # Cache token on first call (decrypt once via sops)
    local token_file="$DATA_DIR/.telegram-token-cache"
    if [ ! -f "$token_file" ]; then
        local secrets
        secrets=$(SOPS_AGE_KEY_FILE="$PROJECT_ROOT/config/age-key.txt" \
            sops --decrypt --extract '["telegram"]' "$PROJECT_ROOT/config/secrets.enc.yaml" 2>/dev/null) || return
        local token=$(echo "$secrets" | grep 'botToken:' | awk '{print $2}')
        local chat=$(echo "$secrets" | grep -A1 'allowedUsers' | tail -1 | tr -d ' "- ')
        if [ -n "$token" ] && [ -n "$chat" ]; then
            echo "${token}" > "$token_file"
            echo "${chat}" >> "$token_file"
        fi
    fi

    [ -f "$token_file" ] || return

    local token=$(head -1 "$token_file")
    local chat_id=$(tail -1 "$token_file")

    curl -s -X POST "https://api.telegram.org/bot${token}/sendMessage" \
        -d chat_id="$chat_id" \
        -d text="🔄 Keepalive restarted: ${restarted}" \
        > /dev/null 2>&1
}

build_if_needed() {
    local DIST_FILE="$PROJECT_ROOT/dist/daemon/supervisor.js"
    local SRC_FILE="$PROJECT_ROOT/src/daemon/supervisor.ts"

    if [ ! -f "$DIST_FILE" ] || [ "$SRC_FILE" -nt "$DIST_FILE" ]; then
        log "Building TypeScript..."
        cd "$PROJECT_ROOT"
        pnpm build 2>&1 | head -20
        return $?
    fi
    return 0
}

# Rotate log files > 5MB
rotate_logs() {
    for logfile in "$LOGS_DIR"/*.log; do
        [ -f "$logfile" ] || continue
        local size=$(stat -f%z "$logfile" 2>/dev/null || echo 0)
        if [ "$size" -gt 5242880 ]; then
            mv "$logfile" "${logfile}.old"
            log "Rotated $(basename "$logfile") (${size} bytes)"
        fi
    done
}

# Cleanup keepalive log if > 10MB
if [ -f "$LOG_FILE" ] && [ $(stat -f%z "$LOG_FILE" 2>/dev/null || echo 0) -gt 10485760 ]; then
    mv "$LOG_FILE" "${LOG_FILE}.old"
fi

log "=== DreamTeam Keepalive Started ==="
log "Project root: $PROJECT_ROOT"
log "Monitoring: bot, supervisor, ${NUM_WORKERS} workers, prototype server"

# Build once on startup
build_if_needed

loop_count=0

# Main loop — check every 30 seconds
while true; do
    restarted=""

    # 1. Supervisor
    if ! is_alive "supervisor.js"; then
        ensure_process "Supervisor" "supervisor.js" "node dist/daemon/supervisor.js" "$LOGS_DIR/supervisor.log"
        restarted="${restarted}supervisor, "
    fi

    # 2. Bot
    if ! is_alive "bot/index.js"; then
        ensure_process "Bot" "bot/index.js" "node dist/bot/index.js" "$LOGS_DIR/bot.log"
        restarted="${restarted}bot, "
    fi

    # 3. Workers
    for i in $(seq 0 $((NUM_WORKERS - 1))); do
        if ! is_alive "worker.js --id $i"; then
            ensure_process "Worker $i" "worker.js --id $i" "node dist/daemon/worker.js --id $i" "$LOGS_DIR/worker-$i.log"
            restarted="${restarted}worker-$i, "
        fi
    done

    # 4. Prototype server
    if ! is_alive "prototype-server.js"; then
        ensure_process "Prototype server" "prototype-server.js" "node dist/director/prototype-server.js" "$LOGS_DIR/prototype-server.log"
        restarted="${restarted}prototype-server, "
    fi

    # Send alert if anything was restarted
    if [ -n "$restarted" ]; then
        restarted="${restarted%, }"  # trim trailing comma
        send_crash_alert "$restarted"
    fi

    # Rotate logs every ~30 minutes (60 loops × 30s)
    loop_count=$((loop_count + 1))
    if [ $((loop_count % 60)) -eq 0 ]; then
        rotate_logs
    fi

    sleep 30
done
