#!/usr/bin/env python3
"""
Kokoro TTS + LLM Summarization Server
Serves speech synthesis and local LLM summarization via OpenAI-compatible endpoints.

Usage:
  # TTS only
  uv run kokoro-server.py --port 8765

  # TTS + summarization
  uv run kokoro-server.py --port 8765 --llm-model mlx-community/Qwen3.5-4B-4bit

Endpoints:
  GET  /health                  — server status
  GET  /status                  — TTS playback state
  POST /v1/audio/speech         — TTS speak (also: /speak)
  POST /stop                    — stop playback
  POST /summarize               — LLM summarization (also: /v1/chat/completions)
"""

import argparse
import sys
import signal
import threading
import time
from typing import Optional, Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from state import ServerState
from llm_engine import load_llm, generate_response, stream_response, stream_and_speak

# ── Global state ──
_state = ServerState()

# ── Lazy TTS imports ──
_kokoro_tts = None
_keyboard = None
_Listener = None


def _load_tts_deps():
    """Import TTS dependencies. Called during startup."""
    global _kokoro_tts, _keyboard, _Listener
    from kokoro_mlx import KokoroTTS
    from pynput import keyboard as kb
    from pynput.keyboard import Listener
    _kokoro_tts = KokoroTTS
    _keyboard = kb
    _Listener = Listener


# ── TTS playback ──

import queue as _queue

_speak_queue: _queue.Queue = _queue.Queue()
_speak_worker_active = True


def _speak_worker():
    """Background thread that plays queued speech chunks sequentially."""
    global _speak_worker_active
    while _speak_worker_active:
        try:
            item = _speak_queue.get(timeout=0.5)
        except _queue.Empty:
            continue
        if item is None:  # sentinel — shutdown
            break
        text, voice, speed = item
        stop_evt = threading.Event()
        _state.set_stop_event(stop_evt)
        _state.set_playing(True)
        _state.set_text(text)
        try:
            _state.tts_model.speak(
                text, voice=voice, speed=speed, stream=True, stop_event=stop_evt,
            )
        except Exception as e:
            print(f"[error] sequential speak failed: {e}", file=sys.stderr)
        finally:
            _state.set_playing(False)
            _state.set_text("")
            _state.clear_stop_event()


def tts_speak_sequential(text: str, voice: str = "af_bella", speed: float = 1.0) -> None:
    """Queue text for sequential playback without interrupting current speech."""
    _speak_queue.put((text, voice, speed))


def tts_stop():
    """Signal the current speech playback to stop and drain the queue."""
    # Clear any pending sequential chunks
    while not _speak_queue.empty():
        try:
            _speak_queue.get_nowait()
        except _queue.Empty:
            break
    evt = _state.clear_stop_event()
    if evt:
        evt.set()
    _state.set_playing(False)
    _state.set_text("")


def tts_speak(text: str, voice: str = "af_bella", speed: float = 1.0) -> None:
    """Begin speaking in a background thread. Stops any current playback first."""
    if _state.is_playing():
        tts_stop()
        time.sleep(0.15)
        if _state.is_playing():
            time.sleep(0.15)

    stop_evt = threading.Event()
    _state.set_stop_event(stop_evt)
    _state.set_playing(True)
    _state.set_text(text)

    def _run():
        try:
            _state.tts_model.speak(
                text, voice=voice, speed=speed, stream=True, stop_event=stop_evt,
            )
        except Exception as e:
            print(f"[error] speak failed: {e}", file=sys.stderr)
        finally:
            _state.set_playing(False)
            _state.set_text("")
            _state.clear_stop_event()

    t = threading.Thread(target=_run, daemon=True)
    t.start()


def _start_keyboard_listener():
    """Escape key interrupts speech."""
    if _state.listener is not None:
        return

    def on_press(key):
        if key == _keyboard.Key.esc:
            print("[info] escape pressed — stopping speech", flush=True)
            tts_stop()

    try:
        lst = _Listener(on_press=on_press)
        lst.daemon = True
        lst.start()
        _state.listener = lst
        print("[info] escape-key listener active", flush=True)
    except Exception as e:
        print(f"[warn] cannot start escape-key listener: {e}", file=sys.stderr, flush=True)


# ── FastAPI app ──

from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load models on startup, clean up on shutdown."""
    print("Loading TTS dependencies...")
    _load_tts_deps()

    print("Loading TTS model (~300MB first run)...")
    try:
        _state.tts_model = _kokoro_tts.from_pretrained()
        print("TTS model loaded.")
    except Exception as e:
        print(f"[fatal] TTS model loading failed: {e}", file=sys.stderr)
        sys.exit(1)

    _start_keyboard_listener()

    # Start the sequential speech worker
    threading.Thread(target=_speak_worker, daemon=True).start()

    llm_id = getattr(app.state, "llm_model_id", None)
    if llm_id:
        print(f"Loading LLM: {llm_id} ...")
        try:
            model, tok = load_llm(llm_id)
            _state.llm_model = model
            _state.llm_tokenizer = tok
            print("LLM loaded.")
        except Exception as e:
            print(f"[warn] LLM loading failed: {e}", file=sys.stderr, flush=True)

    yield

    global _speak_worker_active
    _speak_worker_active = False
    _speak_queue.put(None)  # sentinel
    tts_stop()

app = FastAPI(title="Kokoro TTS + LLM Server", version="0.2.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Pydantic models ──

class SpeakRequest(BaseModel):
    text: str = Field(..., description="Text to speak")
    voice: str = Field("af_bella", description="Voice name")
    speed: float = Field(1.0, description="Speech speed multiplier")


class ChatMessage(BaseModel):
    role: str
    content: str


class SummarizeRequest(BaseModel):
    messages: list[ChatMessage] = Field(..., description="Chat messages (system + user)")
    temperature: float = Field(0.1, description="Sampling temperature")
    max_tokens: int = Field(80, description="Maximum tokens to generate")
    stream: bool = Field(False, description="Stream the response")
    speak: bool = Field(False, description="Feed streamed words to TTS as they arrive")
    voice: str = Field("af_bella", description="Voice for TTS (when speak=true)")
    speed: float = Field(1.0, description="Speech speed (when speak=true)")
    word_buffer: int = Field(4, description="Min words to accumulate before speaking")


# ── Routes ──

@app.get("/health")
def health():
    return {
        "ok": True,
        "tts": "loaded" if _state.tts_model else "loading",
        "llm": "loaded" if _state.llm_model else "unavailable",
    }


@app.get("/status")
def status():
    return _state.get_status()


@app.post("/v1/audio/speech")
@app.post("/speak")
def speak(req: SpeakRequest):
    if not req.text.strip():
        raise HTTPException(400, "text is required")
    tts_speak(req.text, req.voice, req.speed)
    return {"status": "speaking", "text": req.text[:80]}


@app.post("/stop")
def stop():
    was = _state.is_playing()
    tts_stop()
    return {"stopped": was}


@app.post("/summarize")
@app.post("/v1/chat/completions")
def summarize(req: SummarizeRequest):
    if _state.llm_model is None:
        raise HTTPException(503, "LLM not loaded — start server with --llm-model")

    messages = [m.model_dump() for m in req.messages]

    if req.stream and req.speak:
        def on_words(text: str):
            tts_speak_sequential(text, req.voice, req.speed)

        return StreamingResponse(
            stream_and_speak(
                _state.llm_model,
                _state.llm_tokenizer,
                messages,
                temperature=req.temperature,
                max_tokens=req.max_tokens,
                on_words=on_words,
                word_buffer=req.word_buffer,
            ),
            media_type="text/event-stream",
        )

    if req.stream:
        return StreamingResponse(
            stream_response(
                _state.llm_model,
                _state.llm_tokenizer,
                messages,
                temperature=req.temperature,
                max_tokens=req.max_tokens,
            ),
            media_type="text/event-stream",
        )

    result = generate_response(
        _state.llm_model,
        _state.llm_tokenizer,
        messages,
        temperature=req.temperature,
        max_tokens=req.max_tokens,
    )
    return JSONResponse(result)


# ── Entrypoint ──

def main():
    p = argparse.ArgumentParser(description="Kokoro TTS + LLM Server")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--llm-model", type=str,
                   default="mlx-community/Qwen3.5-4B-4bit",
                   help="HuggingFace MLX model ID (default: Qwen3.5-4B)")
    args = p.parse_args()

    # Store LLM model ID so startup() can load it
    app.state.llm_model_id = args.llm_model

    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="info")


if __name__ == "__main__":
    main()
