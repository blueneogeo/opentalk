#!/usr/bin/env bash
set -euo pipefail

BOLD="\033[1m"
GREEN="\033[32m"
RED="\033[31m"
RESET="\033[0m"

PLUGIN_SRC="$(dirname "$0")/src/opentalk.ts"
AGENT_SRC="$(dirname "$0")/agents/speak.md"
PLUGINS_DIR="$HOME/.config/opencode/plugins"
AGENTS_DIR="$HOME/.config/opencode/agents"
PLUGIN_DST="$PLUGINS_DIR/opentalk.ts"
AGENT_DST="$AGENTS_DIR/speak.md"

_ok()   { echo -e "  ${GREEN}✓${RESET} $1"; }
_info() { echo -e "  ${BOLD}$1${RESET}"; }

install() {
  echo "OpenTalk — installing..."

  mkdir -p "$PLUGINS_DIR" "$AGENTS_DIR"

  # Copy plugin
  cp "$PLUGIN_SRC" "$PLUGIN_DST"
  _ok "Plugin installed: $PLUGIN_DST"

  # Copy speak agent (only if not already present — respect user overrides)
  if [ ! -f "$AGENT_DST" ]; then
    cp "$AGENT_SRC" "$AGENT_DST"
    _ok "Speak agent installed: $AGENT_DST"
  else
    _info "Speak agent already exists (user override): $AGENT_DST"
    _info "  (skipped to preserve your custom version)"
  fi

  echo ""
  echo "OpenTalk installed."
  echo "Add 'speak: \"summarize what you just did in one sentence\"' to any agent .md file."
  echo "Then restart OpenCode."
}

uninstall() {
  echo "OpenTalk — uninstalling..."

  if [ -f "$PLUGIN_DST" ]; then
    rm "$PLUGIN_DST"
    _ok "Removed: $PLUGIN_DST"
  else
    _info "Plugin not found: $PLUGIN_DST"
  fi

  if [ -f "$AGENT_DST" ]; then
    rm "$AGENT_DST"
    _ok "Removed: $AGENT_DST"
  else
    _info "Speak agent not found: $AGENT_DST"
  fi

  echo ""
  echo "OpenTalk uninstalled."
}

case "${1:-}" in
  install)   install ;;
  uninstall) uninstall ;;
  *)
    echo "Usage: $0 {install|uninstall}"
    exit 1
    ;;
esac
