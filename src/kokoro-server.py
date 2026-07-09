#!/usr/bin/env python3
"""
Kokoro TTS Server — streaming text-to-speech with MLX on Apple Silicon.
kokoro-mlx handles audio playback internally via sounddevice.
Escape key interrupts playback globally.

Usage:  uv run kokoro-server.py [--port 8765]
Test:   curl http://127.0.0.1:8765/health
Speak:  curl -X POST :8765/speak -H "Content-Type: application/json" -d '{"text":"hello","voice":"af_bella"}'
Status: curl http://127.0.0.1:8765/status
Stop:   curl -X POST :8765/stop
"""

import argparse
import json
import threading
import time
import sys
import signal
from http.server import HTTPServer, BaseHTTPRequestHandler

# ── Lazy imports ──
_kokoro_tts = None
_keyboard = None
_Listener = None

def _load_deps():
    global _kokoro_tts, _keyboard, _Listener
    from kokoro_mlx import KokoroTTS
    from pynput import keyboard as kb
    from pynput.keyboard import Listener
    _kokoro_tts = KokoroTTS
    _keyboard = kb
    _Listener = Listener


# ── State ──
_state = {"model": None, "playing": False, "text": "", "stop_event": None, "listener": None}


def stop():
    if _state["stop_event"]:
        _state["stop_event"].set()
    _state["playing"] = False
    _state["text"] = ""


def _start_listener():
    if _state["listener"]:
        return
    def on_press(key):
        if key == _keyboard.Key.esc:
            stop()
    lst = _Listener(on_press=on_press)
    lst.daemon = True
    lst.start()
    _state["listener"] = lst


def speak_async(text, voice="af_bella", speed=1.0):
    if _state["playing"]:
        stop()
        time.sleep(0.15)

    stop_evt = threading.Event()
    _state["stop_event"] = stop_evt
    _state["playing"] = True
    _state["text"] = text
    _start_listener()

    def _run():
        try:
            _state["model"].speak(text, voice=voice, speed=speed, stream=True, stop_event=stop_evt)
        except Exception as e:
            print(f"[error] speak failed: {e}", file=sys.stderr)
        finally:
            _state["playing"] = False
            _state["text"] = ""
            _state["stop_event"] = None

    t = threading.Thread(target=_run, daemon=True)
    t.start()


# ── HTTP ──
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass

    def _json(self, status, data):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode() + b"\n")

    def _body(self):
        n = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(n).decode() if n else ""

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "model": "loaded" if _state["model"] else "loading"})
        elif self.path == "/status":
            self._json(200, {"playing": _state["playing"], "text": _state["text"][:80] if _state["text"] else ""})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        body = self._body()
        try:
            data = json.loads(body) if body else {}
        except json.JSONDecodeError:
            self._json(400, {"error": "invalid json"}); return

        if self.path == "/speak":
            text = data.get("text", "").strip()
            if not text:
                self._json(400, {"error": "text is required"}); return
            print(f"[speak] text={text[:80]} voice={data.get('voice', 'af_bella')}", flush=True)
            speak_async(text, data.get("voice", "af_bella"), float(data.get("speed", 1.0)))
            self._json(202, {"status": "speaking", "text": text[:80]})

        elif self.path == "/stop":
            was = _state["playing"]
            stop()
            self._json(200, {"stopped": was})

        else:
            self._json(404, {"error": "not found"})


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8765)
    args = p.parse_args()

    print("Loading deps..."); _load_deps()
    print("Loading model (~300MB first run)...")
    _state["model"] = _kokoro_tts.from_pretrained()
    print("Model loaded.")

    srv = HTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Server: http://127.0.0.1:{args.port}")

    def shutdown(*_):
        stop()
        srv.shutdown()
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    srv.serve_forever()


if __name__ == "__main__":
    main()
