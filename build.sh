#!/usr/bin/env bash
set -euo pipefail

BOLD="\033[1m"
GREEN="\033[32m"
RED="\033[31m"
RESET="\033[0m"

PLUGIN_SRC="$(dirname "$0")/src/opentalk.ts"
AGENT_SRC="$(dirname "$0")/agents/speak.md"
SERVER_SRC="$(dirname "$0")/src/kokoro-server.py"
PLUGINS_DIR="$HOME/.config/opencode/plugins"
AGENTS_DIR="$HOME/.config/opencode/agents"
PLUGIN_DST="$PLUGINS_DIR/opentalk.ts"
AGENT_DST="$AGENTS_DIR/opentalk-tts.md"
OPENTALK_DIR="$HOME/.opentalk"
SERVER_DST="$OPENTALK_DIR/kokoro-server.py"
VENV_DIR="$OPENTALK_DIR/venv"
PID_FILE="$OPENTALK_DIR/server.pid"
LOG_FILE="$OPENTALK_DIR/server.log"
PORT=8765

_ok()   { echo -e "  ${GREEN}✓${RESET} $1"; }
_info() { echo -e "  ${BOLD}$1${RESET}"; }
_warn() { echo -e "  ${RED}⚠${RESET} $1"; }

install() {
  echo "OpenTalk — installing..."

  mkdir -p "$PLUGINS_DIR" "$AGENTS_DIR" "$OPENTALK_DIR"

  cp "$PLUGIN_SRC" "$PLUGIN_DST"
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
    # Install uv if needed
    if ! command -v uv &>/dev/null; then
      _info "Installing uv (Python package manager)..."
      curl -LsSf https://astral.sh/uv/install.sh | sh 2>/dev/null || true
      export PATH="$HOME/.local/bin:$PATH"
    fi

    if command -v uv &>/dev/null; then
      _info "Creating Python 3.12 venv (~300MB, one-time)..."
      uv venv --python 3.12 "$VENV_DIR" 2>/dev/null || {
        _warn "Python 3.12 not found — trying system Python"
        uv venv "$VENV_DIR" 2>/dev/null
      }

      _info "Installing kokoro-mlx + deps (~200MB, one-time)..."
      uv pip install --python "$VENV_DIR/bin/python" kokoro-mlx sounddevice pynput 2>/dev/null

      _info "Installing spaCy English model (~14MB, one-time)..."
      uv pip install --python "$VENV_DIR/bin/python" \
        "https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl" \
        2>/dev/null || "$VENV_DIR/bin/python" -m spacy download en_core_web_sm 2>/dev/null || true

      _ok "MLX environment ready"
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
        const cfg = JSON.parse(fs.readFileSync('$OC_JSON','utf-8'));
        cfg.provider = cfg.provider || {};
        cfg.provider.openrouter = {
          npm: '@ai-sdk/openai-compatible',
          name: 'OpenRouter',
          options: { baseURL: 'https://openrouter.ai/api/v1' },
          models: {}
        };
        fs.writeFileSync('$OC_JSON', JSON.stringify(cfg, null, '\t') + '\n', 'utf-8');
      " 2>/dev/null
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
  echo "In-chat commands: /toggle-speak  |  /speak <text>"
  echo "Restart OpenCode."
}

uninstall() {
  echo "OpenTalk — uninstalling..."

  # Stop server if running
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    _info "Stopping TTS server..."
    curl -s -X POST "http://127.0.0.1:$PORT/stop" > /dev/null 2>&1 || true
    sleep 1
    local pid=$(cat "$PID_FILE")
    kill "$pid" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi

  [ -f "$PLUGIN_DST" ] && rm "$PLUGIN_DST" && _ok "Removed: $PLUGIN_DST" || _info "Plugin not found"
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
    local pid=$(cat "$PID_FILE")
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
    local resp=$(curl -s "http://127.0.0.1:$PORT/status" 2>/dev/null || echo '{"error":"not responding"}')
    echo "Server: running (PID $(cat "$PID_FILE"))"
    echo "$resp"
  else
    echo "Server: not running"
  fi
}

case "${1:-}" in
  install)   install ;;
  uninstall) uninstall ;;
  start)     start ;;
  stop)      stop ;;
  status)    status ;;
  *)
    echo "Usage: $0 {install|uninstall|start|stop|status}"
    exit 1
    ;;
esac
