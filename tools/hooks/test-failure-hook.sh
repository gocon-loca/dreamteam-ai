#!/bin/bash
# PostToolUse(Bash): Detect test failures and write a flag file.
# Env-gated: exits immediately if not in a DreamTeam agent context.
# Receives JSON on stdin from Claude Code hooks system.

[[ -z "$DREAMTEAM_GOAL_ID" ]] && exit 0

# Read hook input JSON from stdin
INPUT=$(cat)

# Extract command from tool_input
CMD=$(echo "$INPUT" | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\(.*\)"/\1/p' | head -1)

[[ -z "$CMD" ]] && exit 0

# Only care about test commands that failed
# Check if the command looks like a test runner
if echo "$CMD" | grep -qiE '(npm test|npx jest|npx vitest|pnpm test|pytest|cargo test|go test|make test|yarn test)'; then
  # Check for non-zero exit in tool_output (best effort)
  # PostToolUse fires after the tool ran — if output contains failure indicators, flag it
  if echo "$INPUT" | grep -qE '"exit_code"[[:space:]]*:[[:space:]]*[^0]'; then
    FLAG_FILE="/tmp/dreamteam-test-fail-${DREAMTEAM_GOAL_ID}.flag"
    TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    SAFE_CMD=$(echo "$CMD" | sed 's/"/\\"/g' | head -c 200)
    echo "{\"cmd\":\"$SAFE_CMD\",\"ts\":\"$TIMESTAMP\"}" > "$FLAG_FILE"
  fi
fi

exit 0
