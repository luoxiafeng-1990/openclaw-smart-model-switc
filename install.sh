#!/usr/bin/env bash
set -euo pipefail

# Smart Model Switch — one-click installer for OpenClaw
# Usage: curl -fsSL https://raw.githubusercontent.com/luoxiafeng-1990/openclaw-smart-model-switc/main/install.sh | bash

PLUGIN_ID="smart-model-switch"
REPO_URL="https://github.com/luoxiafeng-1990/openclaw-smart-model-switc.git"

OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-${CLAWDBOT_STATE_DIR:-$HOME/.openclaw}}"
INSTALL_DIR="$OPENCLAW_STATE_DIR/extensions/$PLUGIN_ID"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$OPENCLAW_STATE_DIR/openclaw.json}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[smart-model-switch]${NC} $*"; }
warn()  { echo -e "${YELLOW}[smart-model-switch]${NC} $*"; }
error() { echo -e "${RED}[smart-model-switch]${NC} $*" >&2; }

# ── Step 1: Check prerequisites ──────────────────────────────

if ! command -v git &>/dev/null; then
  error "git is required but not found. Install git and retry."
  exit 1
fi

if [ ! -d "$OPENCLAW_STATE_DIR" ]; then
  error "OpenClaw state directory not found at $OPENCLAW_STATE_DIR"
  error "Make sure OpenClaw is installed and has been run at least once."
  exit 1
fi

# ── Step 2: Clone / update plugin files ──────────────────────

info "Installing $PLUGIN_ID to $INSTALL_DIR ..."

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

git clone --depth 1 "$REPO_URL" "$TMPDIR/repo" 2>/dev/null

mkdir -p "$INSTALL_DIR"
cp "$TMPDIR/repo/index.js"              "$INSTALL_DIR/index.js"
cp "$TMPDIR/repo/package.json"           "$INSTALL_DIR/package.json"
cp "$TMPDIR/repo/openclaw.plugin.json"   "$INSTALL_DIR/openclaw.plugin.json"

info "Plugin files installed."

# ── Step 3: Patch openclaw.json (add to plugins.allow + entries) ─

if [ ! -f "$CONFIG_PATH" ]; then
  warn "Config file not found at $CONFIG_PATH — skipping auto-config."
  warn "Manually add '$PLUGIN_ID' to plugins.allow and plugins.entries in your openclaw.json."
else
  if command -v node &>/dev/null; then
    node -e "
      const fs = require('fs');
      const p  = '$CONFIG_PATH';
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));

      // Ensure plugins section exists
      if (!cfg.plugins) cfg.plugins = {};
      if (!Array.isArray(cfg.plugins.allow)) cfg.plugins.allow = [];
      if (!cfg.plugins.entries) cfg.plugins.entries = {};

      // Add to allow list if missing
      if (!cfg.plugins.allow.includes('$PLUGIN_ID')) {
        cfg.plugins.allow.push('$PLUGIN_ID');
      }

      // Add default config entry if missing
      if (!cfg.plugins.entries['$PLUGIN_ID']) {
        cfg.plugins.entries['$PLUGIN_ID'] = {
          config: {
            providers: {},
            preferProvider: 'minimax',
            probeIntervalHours: 1
          }
        };
      }

      fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
    "
    info "Updated $CONFIG_PATH (added plugin to allow list + default config)."
  else
    warn "node not found — cannot auto-patch openclaw.json."
    warn "Manually add '$PLUGIN_ID' to plugins.allow and plugins.entries."
  fi
fi

# ── Step 4: Done ─────────────────────────────────────────────

echo ""
info "Installation complete!"
echo ""
echo "  Plugin location:  $INSTALL_DIR"
echo "  Config file:      $CONFIG_PATH"
echo ""
echo "  Next steps:"
echo "    1. (Optional) Edit preferProvider in plugins.entries.$PLUGIN_ID.config"
echo "    2. Restart the OpenClaw gateway:"
echo "       openclaw gateway run --force"
echo ""
echo "  The plugin will probe all your configured models on startup"
echo "  and begin smart model switching automatically."
echo ""
