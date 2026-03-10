#!/bin/bash
# PreToolUse(Bash): Validate staged files are within expected scope before git commit.
# Env-gated: exits immediately if not in a DreamTeam agent context.
# Receives JSON on stdin from Claude Code hooks system.

[[ -z "$DREAMTEAM_GOAL_ID" ]] && exit 0
[[ -z "$DREAMTEAM_EXPECTED_SCOPE" ]] && exit 0

# Read hook input JSON from stdin
INPUT=$(cat)

# Check if this is actually a git commit command
echo "$INPUT" | grep -q '"command"' || exit 0
echo "$INPUT" | grep -q "git commit" || exit 0

# Get staged files from the working directory
CWD=$(echo "$INPUT" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
STAGED=$(cd "$CWD" 2>/dev/null && git diff --cached --name-only 2>/dev/null)
[[ -z "$STAGED" ]] && exit 0

# Check each staged file against expected scope patterns
# DREAMTEAM_EXPECTED_SCOPE is a comma-separated list of glob patterns
IFS=',' read -ra PATTERNS <<< "$DREAMTEAM_EXPECTED_SCOPE"
OUT_OF_SCOPE=""

while IFS= read -r file; do
  IN_SCOPE=false
  for pattern in "${PATTERNS[@]}"; do
    pattern=$(echo "$pattern" | xargs) # trim whitespace
    if [[ "$file" == $pattern ]] || [[ "$file" == *"$pattern"* ]]; then
      IN_SCOPE=true
      break
    fi
  done
  if [[ "$IN_SCOPE" == false ]]; then
    OUT_OF_SCOPE="$OUT_OF_SCOPE\n  - $file"
  fi
done <<< "$STAGED"

if [[ -n "$OUT_OF_SCOPE" ]]; then
  # Log but don't block — agent may have good reason
  LOG_FILE="/tmp/dreamteam-scope-flags-${DREAMTEAM_GOAL_ID}.jsonl"
  TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  echo "{\"event\":\"out-of-scope-commit\",\"files\":\"$(echo -e "$OUT_OF_SCOPE" | tr '\n' ',')\",\"ts\":\"$TIMESTAMP\"}" >> "$LOG_FILE"
fi

exit 0
