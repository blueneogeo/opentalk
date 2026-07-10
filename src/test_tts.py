#!/usr/bin/env python3
"""
Automated TTS quality test: save kokoro audio to WAV, transcribe with whisper,
and verify the full text is present in the output.

Usage:  uv run python src/test_tts.py
"""

import re
import sys
import time
import wave
from pathlib import Path


def test_kokoro_save():
    """Verify kokoro_mlx.save() produces complete audio."""
    from kokoro_mlx import KokoroTTS

    TEXT = "I rewrote the server from HTTP to FastAPI with three modules."
    PATH = "/tmp/opentalk_test.wav"

    print(f"Input text: \"{TEXT}\" ({len(TEXT.split())} words)")

    print("Loading TTS model...", flush=True)
    tts = KokoroTTS.from_pretrained()

    print("Saving to WAV...", flush=True)
    t0 = time.time()
    tts.save(TEXT, PATH, voice="af_bella", speed=1.0, sample_rate=24000)
    save_ms = (time.time() - t0) * 1000

    # ── WAV integrity ──
    with wave.open(PATH, "r") as w:
        frames = w.getnframes()
        rate = w.getframerate()
        duration = frames / rate

    print(f"  WAV: {duration:.1f}s, {rate}Hz, {frames} frames, {save_ms:.0f}ms save")
    assert duration > len(TEXT.split()) * 0.3, "duration too short for word count"
    assert duration < 30, "duration suspiciously long"

    # ── Transcribe with whisper ──
    print("Transcribing with whisper-tiny...", flush=True)
    from mlx_audio.stt.utils import load_model, load_audio

    model = load_model("openai/whisper-tiny")
    audio = load_audio(PATH)
    result = model.generate(audio)
    transcribed = result.text.strip()

    print(f"  Whisper: \"{transcribed}\"")

    # ── Verify content ──
    input_words = set(re.findall(r"[a-zA-Z]+", TEXT.lower()))
    output_words = set(re.findall(r"[a-zA-Z]+", transcribed.lower()))
    missing = input_words - output_words
    extra = output_words - input_words

    print(f"\n  Input words:  {sorted(input_words)}")
    print(f"  Output words: {sorted(output_words)}")
    print(f"  Missing: {sorted(missing) if missing else 'none'}")
    print(f"  Extra:   {sorted(extra) if extra else 'none'}")

    match_pct = len(input_words - missing) / len(input_words) * 100 if input_words else 0
    print(f"  Match: {match_pct:.0f}%")

    assert len(missing) <= 2, f"too many missing words: {missing}"
    print("\n✓ PASS: WAV contains complete audio")


def main():
    test_kokoro_save()


if __name__ == "__main__":
    main()
