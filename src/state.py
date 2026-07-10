"""
Server state — thread-safe container for TTS and LLM runtime state.

Extracted from kokoro-server.py to keep the server entrypoint lean.
"""

import threading
from typing import Optional, Dict, Any


class ServerState:
    """Thread-safe container for TTS server state."""

    def __init__(self):
        self._lock = threading.Lock()
        self.tts_model = None      # kokoro_mlx.KokoroTTS
        self.llm_model = None      # mlx.nn.Module or None if no LLM
        self.llm_tokenizer = None  # tokenizer or None if no LLM
        self.playing = False
        self.text = ""
        self.stop_event: Optional[threading.Event] = None
        self.listener: Any = None

    # ── TTS playback state ──

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
                "tts_loaded": self.tts_model is not None,
                "llm_loaded": self.llm_model is not None,
            }
