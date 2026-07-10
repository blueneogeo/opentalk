"""
LLM engine — loads a local MLX model and provides summarization endpoints.

Handles prompt building, token generation, and SSE streaming.
"""

import re
import time
import json
from typing import Generator


def load_llm(model_id: str):
    """Load a model from HuggingFace/MLX community. Returns (model, tokenizer)."""
    from mlx_lm import load
    return load(model_id)


def build_prompt(tokenizer, messages: list[dict]) -> tuple[str, int]:
    """Build a prompt from chat messages using the tokenizer's template.

    Returns (prompt_string, prompt_token_count).
    """
    prompt = tokenizer.apply_chat_template(
        messages,
        tokenize=False,
        add_generation_prompt=True,
        enable_thinking=False,
    )
    tokens = len(tokenizer.encode(prompt))
    return prompt, tokens


def _clean(text: str) -> str:
    """Remove <think>...</think> blocks and surrounding whitespace."""
    return re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()


def generate_response(
    model,
    tokenizer,
    messages: list[dict],
    temperature: float = 0.1,
    max_tokens: int = 80,
) -> dict:
    """Non-streaming generation. Returns OpenAI-compatible response dict."""
    prompt, prompt_tokens = build_prompt(tokenizer, messages)
    t0 = time.time()

    from mlx_lm import generate
    text = generate(model, tokenizer, prompt=prompt, max_tokens=max_tokens, verbose=False)
    text = _clean(text)
    completion_tokens = len(tokenizer.encode(text))
    elapsed = time.time() - t0

    return {
        "choices": [{"message": {"content": text}}],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
        "model": "local-mlx",
        "timing_ms": round(elapsed * 1000),
    }


def _stream_tokens(model, tokenizer, messages, max_tokens):
    """Yields (text, full_text_so_far) tuples from the LLM, suppressing thinks."""
    prompt, _ = build_prompt(tokenizer, messages)
    full = ""

    from mlx_lm import stream_generate

    in_think = False
    for chunk in stream_generate(model, tokenizer, prompt=prompt, max_tokens=max_tokens):
        text = chunk.text

        if "<think>" in text:
            in_think = True
            continue
        if in_think:
            if "</think>" in text:
                in_think = False
            continue

        if not text.strip():
            continue

        full += text
        yield text, full


def stream_response(
    model,
    tokenizer,
    messages: list[dict],
    temperature: float = 0.1,
    max_tokens: int = 80,
) -> Generator[str, None, None]:
    """SSE streaming generator. Yields OpenAI-compatible SSE data lines."""
    for text, _ in _stream_tokens(model, tokenizer, messages, max_tokens):
        yield f"data: {json.dumps({'choices': [{'delta': {'content': text}}]})}\n\n"
    yield "data: [DONE]\n\n"


def stream_and_speak(
    model,
    tokenizer,
    messages: list[dict],
    temperature: float = 0.1,
    max_tokens: int = 80,
    on_done=None,
) -> Generator[str, None, None]:
    """SSE streaming + TTS. Accumulates full text, yields SSE chunks,
    then calls on_done(full_text) once at the end for smooth TTS playback."""
    full_text = ""
    for text, full in _stream_tokens(model, tokenizer, messages, max_tokens):
        full_text = full
        yield f"data: {json.dumps({'choices': [{'delta': {'content': text}}]})}\n\n"

    if on_done and full_text.strip():
        on_done(full_text.strip())

    yield "data: [DONE]\n\n"
