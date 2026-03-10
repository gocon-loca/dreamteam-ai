#!/bin/bash
# PostToolUse(Write|Edit): Flag when a file change is outside expected scope.
# Env-gated: exits immediately if not in a DreamTeam agent context.
# Receives JSON on stdin from Claude Code hooks system.

[[ -z "$DREAMTEAM_GOAL_ID" ]] && exit 0
[[ -z "$DREAMTEAM_EXPECTED_SCOPE" ]] && exit 0

# Read hook input JSON from stdin
INPUT=$(cat)

# Extract file_path from tool_input
FILE_PATH=$(echo "$INPUT" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')

[[ -z "$FILE_PATH" ]] && exit 0

# Check if file is within expected scope
IFS=',' read -ra PATTERNS <<< "$DREAMTEAM_EXPECTED_SCOPE"
IN_SCOPE=false

for pattern in "${PATTERNS[@]}"; do
  pattern=$(echo "$pattern" | xargs)
  if [[ "$FILE_PATH" == $pattern ]] || [[ "$FILE_PATH" == *"$pattern"* ]]; then
    IN_SCOPE=true
    break
  fi
done

if [[ "$IN_SCOPE" == false ]]; then
  LOG_FILE="/tmp/dreamteam-scope-flags-${DREAMTEAM_GOAL_ID}.jsonl"
  TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  SAFE_PATH=$(echo "$FILE_PATH" | sed 's/"/\\"/g')
  echo "{\"path\":\"$SAFE_PATH\",\"reason\":\"outside expected scope\",\"ts\":\"$TIMESTAMP\"}" >> "$LOG_FILE"
fi

exit 0
