#!/bin/bash
# rm-guard-hook.sh - Claude Code pre-hook to prevent dangerous rm commands
# Install: claude hooks add PreToolUse bash "/path/to/rm-guard-hook.sh"

# This hook receives JSON on stdin with the tool call details
# For Bash tool, we check if the command contains dangerous rm patterns

INPUT=$(cat)

# Extract tool name and command
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only check Bash tool
if [ "$TOOL_NAME" != "Bash" ]; then
  exit 0
fi

# Protected paths - NEVER delete these
PROTECTED_PATHS=(
  "$HOME"
  "/Users"
  "/System"
  "/Applications"
  "/Library"
  "/bin"
  "/sbin"
  "/usr"
  "/var"
  "/etc"
)

# Project roots - require extra caution
PROJECT_ROOT="$HOME/projects"

# Check if this is an rm command
if echo "$COMMAND" | grep -qE '^rm\s'; then

  # Check for dangerous rm -rf patterns
  if echo "$COMMAND" | grep -qE 'rm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+-[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*\s+-[a-zA-Z]*r|-[a-zA-Z]*rf|-[a-zA-Z]*fr)'; then

    # Extract paths from command
    PATHS=$(echo "$COMMAND" | sed 's/rm\s\+[^ ]*//g' | tr ' ' '\n' | grep -v '^-')

    for PATH_ARG in $PATHS; do
      # Resolve to absolute path
      if [[ "$PATH_ARG" == /* ]]; then
        ABS_PATH="$PATH_ARG"
      else
        ABS_PATH="$(pwd)/$PATH_ARG"
      fi

      # Normalize path
      ABS_PATH=$(echo "$ABS_PATH" | sed 's|/\+|/|g' | sed 's|/$||')

      # Check protected paths
      for PROTECTED in "${PROTECTED_PATHS[@]}"; do
        if [ "$ABS_PATH" == "$PROTECTED" ]; then
          echo "BLOCKED: Cannot rm -rf protected system path: $ABS_PATH" >&2
          exit 2
        fi
      done

      # Check if it's a project root itself
      if [ "$ABS_PATH" == "$PROJECT_ROOT" ]; then
        echo "BLOCKED: Cannot rm -rf the projects directory: $ABS_PATH" >&2
        exit 2
      fi

      # Check if it's a top-level project directory
      PARENT_DIR=$(dirname "$ABS_PATH")
      if [ "$PARENT_DIR" == "$PROJECT_ROOT" ]; then
        echo "BLOCKED: Cannot rm -rf entire project directory: $ABS_PATH" >&2
        echo "Delete specific files/subdirectories instead." >&2
        exit 2
      fi
    done
  fi
fi

# Allow the command
exit 0
