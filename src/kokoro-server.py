#!/usr/bin/env python3
"""
Kokoro TTS Server — streaming text-to-speech with MLX on Apple Silicon.
kokoro-mlx handles audio playback internally via sounddevice.
Escape key interrupts playback globally (opt-in via --keyboard-interrupt).

Usage:  uv run kokoro-server.py [--port 8765] [--keyboard-interrupt]
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
from typing import Optional, Dict, Any

# ── Lazy imports ──
_kokoro_tts = None
_keyboard = None
_Listener = None


def _load_deps():
    """Import heavy dependencies. Must be called during server startup."""
    global _kokoro_tts, _keyboard, _Listener
    try:
        from kokoro_mlx import KokoroTTS
        from pynput import keyboard as kb
        from pynput.keyboard import Listener

        _kokoro_tts = KokoroTTS
        _keyboard = kb
        _Listener = Listener
    except ImportError as e:
        print(f"[fatal] missing dependency: {e}", file=sys.stderr)
        sys.exit(1)


# ── Thread-safe state ──


class ServerState:
    """Thread-safe container for TTS server state."""

    def __init__(self):
        self._lock = threading.Lock()
        self.model = None
        self.playing = False
        self.text = ""
        self.stop_event: Optional[threading.Event] = None
        self.listener: Any = None

    def set_stop_event(self, event: threading.Event) -> None:
        with self._lock:
            self.stop_event = event

    def clear_stop_event(self) -> Optional[threading.Event]:
        with self._lock:
            evt = self.stop_event
            self.stop_event = None
            return evt

    def set_playing(self, playing: bool) -> None:
        with self._lock:
            self.playing = playing

    def is_playing(self) -> bool:
        with self._lock:
            return self.playing

    def set_text(self, text: str) -> None:
        with self._lock:
            self.text = text

    def get_status(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "playing": self.playing,
                "text": self.text[:80] if self.text else "",
            }


_state = ServerState()
_keyboard_enabled = False


def stop():
    """Signal the current speech playback to stop."""
    evt = _state.clear_stop_event()
    if evt:
        evt.set()
    _state.set_playing(False)
    _state.set_text("")


def _start_listener():
    """Start the global keyboard listener on first speak call."""
    if _state.listener is not None:
        return
    if not _keyboard_enabled:
        return

    def on_press(key):
        if key == _keyboard.Key.esc:
            stop()

    lst = _Listener(on_press=on_press)
    lst.daemon = True
    lst.start()
    _state.listener = lst


def speak_async(text: str, voice: str = "af_bella", speed: float = 1.0) -> None:
    """Begin playing speech in a background thread."""
    if _state.is_playing():
        # Stop current playback and wait for cleanup
        stop()
        time.sleep(0.15)
        # Double-check the previous thread fully reset
        if _state.is_playing():
            time.sleep(0.15)

    stop_evt = threading.Event()
    _state.set_stop_event(stop_evt)
    _state.set_playing(True)
    _state.set_text(text)
    _start_listener()

    def _run():
        try:
            _state.model.speak(
                text, voice=voice, speed=speed, stream=True, stop_event=stop_evt
            )
        except Exception as e:
            print(f"[error] speak failed: {e}", file=sys.stderr)
        finally:
            _state.set_playing(False)
            _state.set_text("")
            _state.clear_stop_event()

    t = threading.Thread(target=_run, daemon=True)
    t.start()


# ── HTTP ──


def _read_body(rfile, headers) -> str:
    """Read exactly Content-Length bytes from the socket (handles TCP fragmentation)."""
    n = int(headers.get("Content-Length", 0))
    if n == 0:
        return ""
    chunks = []
    remaining = n
    while remaining > 0:
        chunk = rfile.read(remaining)
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks).decode()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        # Suppress default HTTP access logging (noisy in a plugin context)
        pass

    def _json(self, status: int, data: Dict[str, Any]) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            self.wfile.write(json.dumps(data).encode() + b"\n")
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _body(self) -> str:
        return _read_body(self.rfile, self.headers)

    def do_GET(self):
        if self.path == "/health":
            self._json(
                200,
                {
                    "ok": True,
                    "model": "loaded" if _state.model else "loading",
                },
            )
        elif self.path == "/status":
            self._json(200, _state.get_status())
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        body = self._body()
        try:
            data = json.loads(body) if body else {}
        except json.JSONDecodeError:
            self._json(400, {"error": "invalid json"})
            return

        if self.path == "/speak":
            text = data.get("text", "").strip()
            if not text:
                self._json(400, {"error": "text is required"})
                return
            print(
                f"[speak] text={text[:80]} voice={data.get('voice', 'af_bella')}",
                flush=True,
            )
            speak_async(
                text, data.get("voice", "af_bella"), float(data.get("speed", 1.0))
            )
            self._json(202, {"status": "speaking", "text": text[:80]})

        elif self.path == "/stop":
            was = _state.is_playing()
            stop()
            self._json(200, {"stopped": was})

        else:
            self._json(404, {"error": "not found"})


def main():
    global _keyboard_enabled

    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8765)
    p.add_argument(
        "--keyboard-interrupt",
        action="store_true",
        dest="keyboard_interrupt",
        help="Enable global escape-key listener to interrupt speech",
    )
    args = p.parse_args()

    _keyboard_enabled = args.keyboard_interrupt

    print("Loading deps...")
    _load_deps()
    print("Loading model (~300MB first run)...")
    try:
        _state.model = _kokoro_tts.from_pretrained()
    except Exception as e:
        print(f"[fatal] model loading failed: {e}", file=sys.stderr)
        sys.exit(1)
    print("Model loaded.")

    srv = HTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Server: http://127.0.0.1:{args.port}")

    def shutdown(*_):
        stop()
        # shutdown() must be called from a thread other than the signal handler
        t = threading.Thread(target=srv.shutdown, daemon=True)
        t.start()
        t.join(timeout=2)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
