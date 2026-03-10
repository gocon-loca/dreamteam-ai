#!/usr/bin/env bash
#
# DreamTeam Bootstrap Script
#
# Downloads and installs everything you need to run DreamTeam.
# Safe to run multiple times — skips anything already installed.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/gocon-loca/dreamteam-ai/main/scripts/bootstrap.sh | bash
#
# Or download first and inspect:
#   curl -fsSL https://raw.githubusercontent.com/gocon-loca/dreamteam-ai/main/scripts/bootstrap.sh -o bootstrap.sh
#   less bootstrap.sh
#   bash bootstrap.sh
#

set -euo pipefail

# ── Colors ───────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

step() { echo -e "\n${BLUE}${BOLD}==>${RESET}${BOLD} $1${RESET}"; }
ok()   { echo -e "  ${GREEN}✓${RESET} $1"; }
warn() { echo -e "  ${YELLOW}!${RESET} $1"; }
fail() { echo -e "  ${RED}✗${RESET} $1"; }
dim()  { echo -e "  ${DIM}$1${RESET}"; }

# ── Detect OS ────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"

if [[ "$OS" != "Darwin" && "$OS" != "Linux" ]]; then
  fail "Unsupported OS: $OS. DreamTeam supports macOS and Linux."
  exit 1
fi

echo ""
echo -e "${BOLD}DreamTeam Bootstrap${RESET}"
echo -e "${DIM}Setting up prerequisites for DreamTeam on ${OS} (${ARCH})${RESET}"

# ── Homebrew (macOS) ─────────────────────────────────────────
if [[ "$OS" == "Darwin" ]]; then
  step "Checking Homebrew"
  if command -v brew &>/dev/null; then
    ok "Homebrew found: $(brew --prefix)"
  else
    warn "Homebrew not found. Installing..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

    # Add brew to PATH for the rest of this script
    if [[ "$ARCH" == "arm64" ]]; then
      eval "$(/opt/homebrew/bin/brew shellenv)"
    else
      eval "$(/usr/local/bin/brew shellenv)"
    fi

    if command -v brew &>/dev/null; then
      ok "Homebrew installed"
    else
      fail "Homebrew install failed. Visit https://brew.sh for manual instructions."
      exit 1
    fi
  fi
fi

# ── Git ──────────────────────────────────────────────────────
step "Checking Git"
if command -v git &>/dev/null; then
  ok "Git found: $(git --version | head -1)"
else
  warn "Git not found. Installing..."
  if [[ "$OS" == "Darwin" ]]; then
    # This triggers Xcode Command Line Tools install if needed
    xcode-select --install 2>/dev/null || true
    echo "    If a dialog appeared, click Install and wait for it to finish."
    echo "    Then re-run this script."
    exit 0
  else
    sudo apt-get update -qq && sudo apt-get install -y -qq git
  fi
  ok "Git installed"
fi

# ── Node.js 22+ ─────────────────────────────────────────────
step "Checking Node.js (need v22+)"
NEED_NODE=false

if command -v node &>/dev/null; then
  NODE_VERSION="$(node --version)"
  NODE_MAJOR="$(echo "$NODE_VERSION" | sed 's/v//' | cut -d. -f1)"
  if [[ "$NODE_MAJOR" -ge 22 ]]; then
    ok "Node.js found: ${NODE_VERSION}"
  else
    warn "Node.js ${NODE_VERSION} found, but v22+ is required"
    NEED_NODE=true
  fi
else
  warn "Node.js not found"
  NEED_NODE=true
fi

if [[ "$NEED_NODE" == "true" ]]; then
  dim "Installing Node.js 22..."
  if [[ "$OS" == "Darwin" ]]; then
    brew install node@22
    # Link it so it's in PATH
    brew link --overwrite node@22 2>/dev/null || true

    # If brew link didn't work (keg-only), add to PATH
    if ! node --version 2>/dev/null | grep -q "^v2[2-9]"; then
      NODE_PREFIX="$(brew --prefix node@22)"
      export PATH="${NODE_PREFIX}/bin:$PATH"

      # Persist in shell profile
      SHELL_RC="$HOME/.zshrc"
      [[ -f "$HOME/.bashrc" && ! -f "$HOME/.zshrc" ]] && SHELL_RC="$HOME/.bashrc"

      if ! grep -q "node@22" "$SHELL_RC" 2>/dev/null; then
        echo "" >> "$SHELL_RC"
        echo "# Node.js 22 (added by DreamTeam bootstrap)" >> "$SHELL_RC"
        echo "export PATH=\"${NODE_PREFIX}/bin:\$PATH\"" >> "$SHELL_RC"
        dim "Added Node.js 22 to ${SHELL_RC}"
      fi
    fi
  else
    # Linux — use NodeSource
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y -qq nodejs
  fi

  if node --version 2>/dev/null | grep -q "^v2[2-9]"; then
    ok "Node.js $(node --version) installed"
  else
    fail "Node.js 22 installation failed."
    echo "    Install manually from https://nodejs.org (pick the LTS v22 version)"
    echo "    Then re-run this script."
    exit 1
  fi
fi

# ── pnpm ─────────────────────────────────────────────────────
step "Checking pnpm"
if command -v pnpm &>/dev/null; then
  ok "pnpm found: v$(pnpm --version)"
else
  dim "Installing pnpm..."
  npm install -g pnpm
  if command -v pnpm &>/dev/null; then
    ok "pnpm installed: v$(pnpm --version)"
  else
    fail "pnpm install failed. Try: npm install -g pnpm"
    exit 1
  fi
fi

# ── Claude Code CLI ──────────────────────────────────────────
step "Checking Claude Code CLI"
if command -v claude &>/dev/null; then
  ok "Claude CLI found: $(claude --version 2>/dev/null | head -1 || echo 'installed')"
else
  dim "Installing Claude Code CLI..."
  npm install -g @anthropic-ai/claude-code
  if command -v claude &>/dev/null; then
    ok "Claude CLI installed"
  else
    warn "Claude CLI install may need a new terminal to take effect"
  fi
fi

# ── Clone DreamTeam ──────────────────────────────────────────
step "Setting up DreamTeam"

# Determine install location
INSTALL_DIR="${DREAMTEAM_DIR:-$HOME/dreamteam-ai}"

if [[ -d "$INSTALL_DIR" && -f "$INSTALL_DIR/package.json" ]]; then
  ok "DreamTeam already cloned at $INSTALL_DIR"
  cd "$INSTALL_DIR"
else
  # Check if we're already inside the repo
  if [[ -f "package.json" ]] && grep -q '"dreamteam"' package.json 2>/dev/null; then
    ok "Already inside DreamTeam repo"
    INSTALL_DIR="$(pwd)"
  else
    dim "Cloning into $INSTALL_DIR..."
    git clone https://github.com/gocon-loca/dreamteam-ai.git "$INSTALL_DIR"
    cd "$INSTALL_DIR"
    ok "Cloned to $INSTALL_DIR"
  fi
fi

# ── Install dependencies ────────────────────────────────────
step "Installing dependencies"
cd "$INSTALL_DIR"
pnpm install
ok "Dependencies installed"

# ── Summary ──────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}All set!${RESET}"
echo ""
echo -e "  DreamTeam is at: ${BOLD}${INSTALL_DIR}${RESET}"
echo ""
echo -e "  ${BOLD}Next steps:${RESET}"
echo ""
echo -e "    ${BLUE}cd ${INSTALL_DIR}${RESET}"
echo -e "    ${BLUE}pnpm run setup:web${RESET}     # Opens the setup wizard in your browser"
echo ""
echo -e "  The wizard will walk you through:"
echo -e "    - Connecting your AI provider (API key or Claude subscription)"
echo -e "    - Registering your projects"
echo -e "    - Setting up Telegram (optional)"
echo ""
echo -e "  ${DIM}Need help? https://github.com/gocon-loca/dreamteam-ai/issues${RESET}"
echo ""

# ── Auto-launch wizard ──────────────────────────────────────
echo -e -n "Launch the setup wizard now? ${DIM}[Y/n]${RESET} "
read -r REPLY
REPLY="${REPLY:-Y}"

if [[ "$REPLY" =~ ^[Yy]$ ]]; then
  pnpm run setup:web
fi
