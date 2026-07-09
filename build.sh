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
_warn() { echo -e "  ${RED}⚠${RESET} $1"; }

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

  # ── Auto-configure OpenRouter provider ──
  local OC_JSON="$HOME/.config/opencode/opencode.json"

  if [ -n "${OPENROUTER_API_KEY:-}" ]; then
    if [ -f "$OC_JSON" ]; then
      # Check if openrouter provider already exists
      node -e "
        const fs = require('fs');
        const cfg = JSON.parse(fs.readFileSync('$OC_JSON','utf-8'));
        cfg.provider = cfg.provider || {};
        if (!cfg.provider.openrouter) {
          cfg.provider.openrouter = {
            npm: '@ai-sdk/openai-compatible',
            name: 'OpenRouter',
            options: { baseURL: 'https://openrouter.ai/api/v1' },
            models: {}
          };
          fs.writeFileSync('$OC_JSON', JSON.stringify(cfg, null, '\t') + '\n', 'utf-8');
          console.log('added');
        } else {
          console.log('exists');
        }
      " 2>/dev/null
      _ok "OpenRouter provider configured (reads OPENROUTER_API_KEY from env)"
    fi
  else
    _warn "OPENROUTER_API_KEY not set — TTS will fall back to macOS say"
    _info "  Set it in your shell profile to enable OpenRouter TTS:"
    _info "  export OPENROUTER_API_KEY=\"sk-or-v1-...\""
  fi

  echo ""
  echo "OpenTalk installed."
  echo "Add 'speak: \"summarize what you just did in one sentence\"' to any agent .md file."
  echo "Commands: /toggle-speak  |  /speak <text>"
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
