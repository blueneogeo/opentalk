#!/usr/bin/env bash
set -euo pipefail

BOLD="\033[1m"
GREEN="\033[32m"
RED="\033[31m"
RESET="\033[0m"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/src"
BUNDLE_SRC="$SCRIPT_DIR/dist/opentalk.js"
AGENT_SRC="$SCRIPT_DIR/agents/speak.md"
SERVER_SRC="$SRC_DIR/kokoro-server.py"
PLUGINS_DIR="$HOME/.config/opencode/plugins"
AGENTS_DIR="$HOME/.config/opencode/agents"
PLUGIN_DST="$PLUGINS_DIR/opentalk.ts"
AGENT_DST="$AGENTS_DIR/speak.md"
OPENTALK_DIR="$HOME/.opentalk"
SERVER_DST="$OPENTALK_DIR/kokoro-server.py"
VENV_DIR="$OPENTALK_DIR/venv"
PID_FILE="$OPENTALK_DIR/server.pid"
LOG_FILE="$OPENTALK_DIR/server.log"
PORT=8765

_ok()   { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
_info() { printf "  ${BOLD}%s${RESET}\n" "$1"; }
_warn() { printf "  ${RED}⚠${RESET} %s\n" "$1"; }

install() {
  echo "OpenTalk — installing..."

  mkdir -p "$PLUGINS_DIR" "$AGENTS_DIR" "$OPENTALK_DIR"

  # ── Build first ──
  build || { _warn "Build failed — fix errors and retry"; exit 1; }

  # ── Clean up old loose .ts/.js files from previous versions ──
  if [ -d "$PLUGINS_DIR" ]; then
    find "$PLUGINS_DIR" -maxdepth 1 -name "*.ts" ! -name "suffix-plugin.ts" -delete 2>/dev/null || true
    find "$PLUGINS_DIR" -maxdepth 1 -name "*.js" -delete 2>/dev/null || true
    rm -rf "$PLUGINS_DIR/tts-engines" 2>/dev/null || true
  fi

  # ── Install the single bundled file ──
  if [ ! -f "$BUNDLE_SRC" ]; then
    _warn "Bundle not found at $BUNDLE_SRC — run: node build.mjs"
    exit 1
  fi
  cp "$BUNDLE_SRC" "$PLUGIN_DST"
  _ok "Plugin installed: $PLUGIN_DST"

  if [ ! -f "$AGENT_DST" ]; then
    cp "$AGENT_SRC" "$AGENT_DST"
    _ok "Speak agent installed: $AGENT_DST"
  else
    _info "Speak agent already exists (preserved): $AGENT_DST"
  fi

  cp "$SERVER_SRC" "$SERVER_DST"
  _ok "TTS server installed: $SERVER_DST"

  # ── Set up Python MLX environment ──
  if [ ! -d "$VENV_DIR" ]; then
    # Ensure uv is available
    if ! command -v uv &>/dev/null; then
      _info "uv not found — please install it: https://docs.astral.sh/uv/getting-started/installation/"
      _info "On macOS: curl -LsSf https://astral.sh/uv/install.sh | sh"
    fi

    if command -v uv &>/dev/null; then
      _info "Creating Python 3.12 venv (~300MB, one-time)..."
      if ! uv venv --python 3.12 "$VENV_DIR" 2>/dev/null; then
        _info "Python 3.12 not found — trying system Python"
        uv venv "$VENV_DIR" 2>/dev/null || {
          _warn "Failed to create Python venv"
        }
      fi

      if [ -d "$VENV_DIR" ]; then
        _info "Installing kokoro-mlx + deps (~200MB, one-time)..."
        uv pip install --python "$VENV_DIR/bin/python" kokoro-mlx sounddevice pynput 2>/dev/null || {
          _warn "kokoro-mlx installation may have failed — check logs"
        }
        _ok "MLX environment ready"
      fi
    else
      _warn "uv not available — kokoro engine will fall back to say"
    fi
  else
    _ok "MLX environment already exists: $VENV_DIR"
  fi

  # ── OpenRouter provider (only if not already present) ──
  local OC_JSON="$HOME/.config/opencode/opencode.json"
  if [ -n "${OPENROUTER_API_KEY:-}" ] && [ -f "$OC_JSON" ]; then
    if grep -q '"openrouter"' "$OC_JSON" 2>/dev/null; then
      _info "OpenRouter provider already configured (preserved)"
    else
      node -e "
        const fs = require('fs');
        const cfg = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8'));
        cfg.provider = cfg.provider || {};
        cfg.provider.openrouter = {
          npm: '@ai-sdk/openai-compatible',
          name: 'OpenRouter',
          options: { baseURL: 'https://openrouter.ai/api/v1' },
          models: {}
        };
        fs.writeFileSync(process.argv[1], JSON.stringify(cfg, null, '\t') + '\n', 'utf-8');
      " "$OC_JSON" 2>/dev/null || true
      _ok "OpenRouter provider configured (reads OPENROUTER_API_KEY from env)"
    fi
  fi

  echo ""
  echo "OpenTalk installed."
  echo ""
  echo "TTS engines: say (macOS) | kokoro (MLX, local GPU) | openrouter (API)"
  echo "Add 'speak: true' or 'speak: \"...\"' to any agent .md file."
  echo ""
  echo "Server management:"
  echo "  build.sh start    — launch the TTS server"
  echo "  build.sh status   — check if it's running"
  echo "  build.sh stop     — shut it down"
  echo ""
  echo "In-chat commands: /set-speak on|off  |  /speak <text>"
  echo "Restart OpenCode."
}

uninstall() {
  echo "OpenTalk — uninstalling..."

  # Stop server if running
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    _info "Stopping TTS server..."
    curl -s -X POST "http://127.0.0.1:$PORT/stop" > /dev/null 2>&1 || true
    sleep 1
    local pid
    pid=$(cat "$PID_FILE")
    kill "$pid" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi

  # Remove plugin files (old loose .ts files + bundled .js)
  [ -f "$PLUGIN_DST" ] && rm "$PLUGIN_DST" && _ok "Removed: $PLUGIN_DST" || _info "Plugin not found"
  # Clean up any leftover old-format .ts files
  find "$PLUGINS_DIR" -maxdepth 1 -name "opentalk*.ts" -delete 2>/dev/null || true
  rm -rf "$PLUGINS_DIR/tts-engines" 2>/dev/null || true
  [ -f "$AGENT_DST" ] && rm "$AGENT_DST" && _ok "Removed: $AGENT_DST" || _info "Agent not found"
  [ -f "$SERVER_DST" ] && rm "$SERVER_DST" && _ok "Removed: $SERVER_DST" || _info "Server not found"
  [ -f "$LOG_FILE" ] && rm "$LOG_FILE" && _ok "Removed: $LOG_FILE" || true
  [ -d "$VENV_DIR" ] && rm -rf "$VENV_DIR" && _ok "Removed: $VENV_DIR" || _info "Venv not found"

  echo ""
  echo "OpenTalk uninstalled."
}

start() {
  echo "OpenTalk — starting TTS server..."
  mkdir -p "$OPENTALK_DIR"

  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    _info "Server already running (PID $(cat "$PID_FILE"))"
    return 0
  fi

  if [ ! -f "$SERVER_DST" ]; then
    _warn "Server not installed. Run: build.sh install"
    exit 1
  fi

  if [ ! -d "$VENV_DIR" ]; then
    _warn "Python environment not set up. Run: build.sh install"
    exit 1
  fi

  nohup "$VENV_DIR/bin/python3" "$SERVER_DST" --port "$PORT" > "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"

  for i in $(seq 1 60); do
    if curl -s "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
      _ok "Server ready (PID $(cat "$PID_FILE"))"
      # Check for accessibility permission issues
      sleep 1
      if grep -q "not trusted" "$LOG_FILE" 2>/dev/null; then
        _warn "Escape-key interrupt won't work — grant Accessibility permission"
        echo "  System Settings > Privacy & Security > Accessibility"
        echo "  Add your terminal app, then restart: build.sh stop && build.sh start"
      fi
      return 0
    fi
    sleep 0.5
  done

  _warn "Server may still be loading. Check: build.sh status"
}

stop() {
  echo "OpenTalk — stopping TTS server..."

  curl -s -X POST "http://127.0.0.1:$PORT/stop" > /dev/null 2>&1 || true
  sleep 1

  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 0.5
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi

  _ok "Server stopped"
}

status() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    local resp
    resp=$(curl -s "http://127.0.0.1:$PORT/status" 2>/dev/null || echo '{"error":"not responding"}')
    echo "Server: running (PID $(cat "$PID_FILE"))"
    echo "$resp"
  else
    echo "Server: not running"
  fi
}

build() {
  echo "OpenTalk — building..."

  _info "Typecheck..."
  ( cd "$SCRIPT_DIR" && npx tsc --noEmit ) || { _warn "Typecheck failed"; return 1; }
  _ok "Typecheck passed"

  _info "Tests..."
  ( cd "$SCRIPT_DIR" && npx vitest run ) || { _warn "Tests failed"; return 1; }
  _ok "Tests passed"

  _info "Bundle..."
  ( cd "$SCRIPT_DIR" && node build.mjs ) || { _warn "Bundle failed"; return 1; }
  _ok "Bundle built"

  echo "Build complete."
}

case "${1:-}" in
  install)   install ;;
  uninstall) uninstall ;;
  start)     start ;;
  stop)      stop ;;
  status)    status ;;
  build)     build ;;
  *)
    echo "Usage: $0 {install|uninstall|start|stop|status|build}"
    exit 1
    ;;
esac
