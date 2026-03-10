#!/bin/bash
# Sync DreamTeam data and code to the remote remote server
#
# Use this to push updated goals, debriefs, and project data
# to the remote server without doing a full re-deploy.
#
# Usage:
#   ./scripts/sync-to-remote.sh [hostname] [remote-user]
#
# Options:
#   --code    Also pull latest code on remote (git pull all repos)
#   --data    Sync data only (default)
#   --all     Code + data

set -e

REMOTE_HOST="${1:-my-server}"
REMOTE_USER="${2:-remote}"

# Check for flags in any position
SYNC_CODE=false
SYNC_DATA=true
for arg in "$@"; do
    case "$arg" in
        --code) SYNC_CODE=true ;;
        --all) SYNC_CODE=true; SYNC_DATA=true ;;
        --data) SYNC_DATA=true ;;
    esac
done

REMOTE="$REMOTE_USER@$REMOTE_HOST"
REMOTE_PROJECTS="/Users/$REMOTE_USER/projects"
LOCAL_PROJECTS="/Users/$(whoami)/projects"

echo "Syncing to $REMOTE..."

if $SYNC_DATA; then
    echo ""
    echo "[Data] Syncing goals and debriefs..."
    rsync -avz "$LOCAL_PROJECTS/DreamTeam/data/goals.json" \
        "$REMOTE:$REMOTE_PROJECTS/DreamTeam/data/"
    rsync -avz "$LOCAL_PROJECTS/DreamTeam/data/debriefs/" \
        "$REMOTE:$REMOTE_PROJECTS/DreamTeam/data/debriefs/"

    # Knowledge graph
    if [ -f "$LOCAL_PROJECTS/DreamTeam/data/director-knowledge.json" ]; then
        rsync -avz "$LOCAL_PROJECTS/DreamTeam/data/director-knowledge.json" \
            "$REMOTE:$REMOTE_PROJECTS/DreamTeam/data/"
    fi
    fi

    echo "[Data] Done"
fi

if $SYNC_CODE; then
    echo ""
    echo "[Code] Pulling latest on all repos..."
    ssh "$REMOTE" bash << 'PULL_EOF'
    set -e
    PROJECTS_DIR="$HOME/projects"
    for repo in DreamTeam; do
        if [ -d "$PROJECTS_DIR/$repo/.git" ]; then
            echo "  Pulling $repo..."
            cd "$PROJECTS_DIR/$repo"
            git pull --ff-only 2>/dev/null || echo "    (skipped - may have local changes)"
        fi
    done

    # Rebuild DreamTeam
    echo "  Rebuilding DreamTeam..."
    cd "$PROJECTS_DIR/DreamTeam"
    pnpm build 2>&1 | tail -3
    echo "[Code] Done"
PULL_EOF
fi

echo ""
echo "Sync complete."
