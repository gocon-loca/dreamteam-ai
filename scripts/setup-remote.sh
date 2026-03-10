#!/bin/bash
# Deploy DreamTeam to a remote Mac (e.g., remote server for 24/7 operation)
#
# Run this FROM your local machine (local machine).
# It SSHs into the remote, installs everything, and starts the daemon.
#
# Designed for standard (non-admin) users with Homebrew at ~/homebrew.
#
# Usage:
#   ./scripts/setup-remote.sh [hostname] [remote-user]
#
# Example:
#   ./scripts/setup-remote.sh my-server remote

set -e

REMOTE_HOST="${1:-my-server}"
REMOTE_USER="${2:-remote}"
REMOTE="$REMOTE_USER@$REMOTE_HOST"
REMOTE_HOME="/Users/$REMOTE_USER"
REMOTE_PROJECTS="$REMOTE_HOME/projects"

LOCAL_PROJECTS="/Users/$(whoami)/projects"
LOCAL_DREAMTEAM="$LOCAL_PROJECTS/DreamTeam"

echo "========================================="
echo "DreamTeam Remote Deployment"
echo "========================================="
echo "Target:  $REMOTE"
echo "Home:    $REMOTE_HOME"
echo "Projects: $REMOTE_PROJECTS"
echo ""

# Verify SSH connectivity
echo "[1/8] Verifying SSH connectivity..."
if ! ssh -o ConnectTimeout=5 "$REMOTE" "echo 'SSH OK'" 2>/dev/null; then
    echo "ERROR: Cannot SSH to $REMOTE"
    echo "Make sure:"
    echo "  - Tailscale is running on both machines"
    echo "  - SSH is enabled on the remote server (System Settings > General > Sharing > Remote Login)"
    echo "  - You can manually: ssh $REMOTE"
    exit 1
fi
echo "  SSH connection verified"

# Install system dependencies
echo ""
echo "[2/8] Installing system dependencies on $REMOTE_HOST..."
ssh "$REMOTE" bash << 'DEPS_EOF'
set -e

# Detect Homebrew location (standard user may have it at ~/homebrew)
if [ -x "$HOME/homebrew/bin/brew" ]; then
    eval "$($HOME/homebrew/bin/brew shellenv)"
    echo "  Homebrew found at ~/homebrew"
elif [ -x "/opt/homebrew/bin/brew" ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
    echo "  Homebrew found at /opt/homebrew"
elif command -v brew &>/dev/null; then
    echo "  Homebrew found in PATH"
else
    echo "  ERROR: Homebrew not found."
    echo "  For a standard (non-admin) user, install with:"
    echo "    mkdir -p ~/homebrew && curl -L https://github.com/Homebrew/brew/tarball/master | tar xz --strip-components 1 -C ~/homebrew"
    echo "    echo 'eval \"\$(~/homebrew/bin/brew shellenv)\"' >> ~/.zprofile"
    exit 1
fi

# Node 22
if ! node --version 2>/dev/null | grep -q "^v2[2-9]"; then
    echo "  Installing Node 22..."
    brew install node@22
    brew link --overwrite node@22 2>/dev/null || true
else
    echo "  Node $(node --version) already installed"
fi

# Python 3
if ! command -v python3 &>/dev/null; then
    echo "  Installing Python 3..."
    brew install python@3
else
    echo "  Python3 $(python3 --version 2>&1) already installed"
fi

# pnpm
if ! command -v pnpm &>/dev/null; then
    echo "  Installing pnpm..."
    npm install -g pnpm
else
    echo "  pnpm already installed"
fi

# SOPS + age
if ! command -v sops &>/dev/null; then
    echo "  Installing SOPS..."
    brew install mozilla-sops
else
    echo "  SOPS already installed"
fi

if ! command -v age &>/dev/null; then
    echo "  Installing age..."
    brew install age
else
    echo "  age already installed"
fi

# Git (should be there by default on macOS)
if ! command -v git &>/dev/null; then
    echo "  Installing git..."
    brew install git
else
    echo "  git already installed"
fi

echo "  All dependencies installed"
DEPS_EOF

# Clone repositories
echo ""
echo "[3/8] Cloning project repositories..."
ssh "$REMOTE" bash << CLONE_EOF
set -e
mkdir -p "$REMOTE_PROJECTS"

clone_if_missing() {
    local repo="\$1"
    local dest="\$2"
    if [ -d "\$dest/.git" ]; then
        echo "  Already cloned: \$dest"
        cd "\$dest" && git pull --ff-only 2>/dev/null || echo "    (pull skipped - may have local changes)"
    else
        echo "  Cloning: \$repo -> \$dest"
        git clone "\$repo" "\$dest"
    fi
}

# Clone your project repos here. Example:
# clone_if_missing "git@github.com:<your-org>/DreamTeam.git" "$REMOTE_PROJECTS/DreamTeam"
# clone_if_missing "git@github.com:<your-org>/my-project.git" "$REMOTE_PROJECTS/my-project"
clone_if_missing "git@github.com:<your-org>/DreamTeam.git" "$REMOTE_PROJECTS/DreamTeam"

echo "  All repos cloned"
CLONE_EOF

# Copy secrets
echo ""
echo "[4/8] Copying secrets to remote..."
ssh "$REMOTE" "mkdir -p '$REMOTE_PROJECTS/DreamTeam/config'"
scp "$LOCAL_DREAMTEAM/config/age-key.txt" "$REMOTE:$REMOTE_PROJECTS/DreamTeam/config/age-key.txt"
scp "$LOCAL_DREAMTEAM/config/secrets.enc.yaml" "$REMOTE:$REMOTE_PROJECTS/DreamTeam/config/secrets.enc.yaml"
ssh "$REMOTE" "chmod 600 '$REMOTE_PROJECTS/DreamTeam/config/age-key.txt'"
echo "  Secrets copied and permissions set"

# Generate projects.yaml for remote
echo ""
echo "[5/8] Generating remote projects.yaml..."

# Resolve the Tailscale IP of the remote server
REMOTE_TAILSCALE_IP=$(ssh "$REMOTE" "tailscale ip -4 2>/dev/null || echo 'UNKNOWN'")
echo "  remote server Tailscale IP: $REMOTE_TAILSCALE_IP"

cat > /tmp/dreamteam-remote-projects.yaml << PROJECTS_EOF
# DreamTeam Project Registry (generated for $REMOTE_HOST)
# Auto-generated by setup-remote.sh on $(date -u '+%Y-%m-%dT%H:%M:%SZ')

projects:
  dreamteam:
    path: $REMOTE_PROJECTS/DreamTeam
    description: "Multi-project orchestration system"
    hasDevServer: false

  # Add your projects here, e.g.:
  # my-web-app:
  #   path: $REMOTE_PROJECTS/my-web-app
  #   description: "My web application"
  #   hasDevServer: true
  #   devCommand: "npm run dev"
  #   devPort: 3000
  #   healthCheck: "http://${REMOTE_TAILSCALE_IP}:3000"
PROJECTS_EOF

scp /tmp/dreamteam-remote-projects.yaml "$REMOTE:$REMOTE_PROJECTS/DreamTeam/config/projects.yaml"
rm /tmp/dreamteam-remote-projects.yaml
echo "  projects.yaml generated and deployed"

# Install project dependencies
echo ""
echo "[6/8] Installing project dependencies on remote..."
ssh "$REMOTE" bash << 'INSTALL_EOF'
set -e

# Source brew from wherever it lives
if [ -x "$HOME/homebrew/bin/brew" ]; then
    eval "$($HOME/homebrew/bin/brew shellenv)"
elif [ -x "/opt/homebrew/bin/brew" ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
fi

PROJECTS_DIR="$HOME/projects"

# DreamTeam (Node/TypeScript)
echo "  Installing DreamTeam dependencies..."
cd "$PROJECTS_DIR/DreamTeam"
pnpm install 2>&1 | tail -3
pnpm build 2>&1 | tail -3
echo "    DreamTeam built successfully"

# Install your project dependencies here, e.g.:
# cd "$PROJECTS_DIR/my-web-app" && npm install 2>&1 | tail -3
# cd "$PROJECTS_DIR/my-api" && pip3 install --user -r requirements.txt 2>&1 | tail -3

echo "  All project dependencies installed"
INSTALL_EOF

# Sync data
echo ""
echo "[7/8] Syncing data to remote..."
ssh "$REMOTE" "mkdir -p '$REMOTE_PROJECTS/DreamTeam/data/debriefs'"

# Goals and debriefs
rsync -avz "$LOCAL_DREAMTEAM/data/goals.json" "$REMOTE:$REMOTE_PROJECTS/DreamTeam/data/" 2>/dev/null || echo "  (no goals.json yet)"
rsync -avz "$LOCAL_DREAMTEAM/data/debriefs/" "$REMOTE:$REMOTE_PROJECTS/DreamTeam/data/debriefs/" 2>/dev/null || echo "  (no debriefs yet)"

# Sync additional project data here if needed
# rsync -avz "$LOCAL_PROJECTS/my-project/data/" "$REMOTE:$REMOTE_PROJECTS/my-project/data/"
echo "  Data synced"

# Install and start the supervisor daemon
echo ""
echo "[8/8] Installing supervisor daemon..."
ssh "$REMOTE" bash << 'DAEMON_EOF'
set -e

# Source brew
if [ -x "$HOME/homebrew/bin/brew" ]; then
    eval "$($HOME/homebrew/bin/brew shellenv)"
elif [ -x "/opt/homebrew/bin/brew" ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
fi

cd "$HOME/projects/DreamTeam"
./scripts/install-supervisor.sh
DAEMON_EOF

echo ""
echo "========================================="
echo "Deployment complete!"
echo "========================================="
echo ""
echo "MANUAL STEP REQUIRED:"
echo "  SSH into the remote server and authenticate Claude CLI:"
echo ""
echo "    ssh $REMOTE"
echo "    claude login"
echo ""
echo "  This is a one-time interactive step."
echo ""
echo "VERIFY:"
echo "  ssh $REMOTE 'launchctl list | grep dreamteam'"
echo "  ssh $REMOTE 'tail -20 /tmp/dreamteam-keepalive.log'"
echo "  Send /status via Telegram"
echo ""
echo "NOTE: The Telegram bot can only run on ONE machine."
echo "  Stop it on your local machine before relying on the remote server."
echo ""
