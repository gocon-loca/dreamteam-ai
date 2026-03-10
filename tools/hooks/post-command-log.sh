#!/bin/bash
# PostToolUse(Bash): Log commands executed by agents to a JSONL file.
# Env-gated: exits immediately if not in a DreamTeam agent context.
# Receives JSON on stdin from Claude Code hooks system.

[[ -z "$DREAMTEAM_GOAL_ID" ]] && exit 0

# Read hook input JSON from stdin
INPUT=$(cat)

# Extract command from tool_input.command
CMD=$(echo "$INPUT" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\(.*\)"/\1/p' | head -1)

if [[ -n "$CMD" ]]; then
  LOG_FILE="/tmp/dreamteam-cmds-${DREAMTEAM_GOAL_ID}.jsonl"
  TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  # Escape double quotes in command for JSON safety
  SAFE_CMD=$(echo "$CMD" | sed 's/\\/\\\\/g; s/"/\\"/g' | head -c 500)
  echo "{\"cmd\":\"$SAFE_CMD\",\"ts\":\"$TIMESTAMP\"}" >> "$LOG_FILE"
fi

exit 0
