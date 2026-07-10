"""
LLM engine — loads a local MLX model and provides summarization endpoints.

Handles prompt building, token generation, and SSE streaming.
"""

import re
import time
import json
from typing import Generator, Optional


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


def stream_response(
    model,
    tokenizer,
    messages: list[dict],
    temperature: float = 0.1,
    max_tokens: int = 80,
) -> Generator[str, None, None]:
    """SSE streaming generator. Yields OpenAI-compatible SSE data lines."""
    return _stream_impl(model, tokenizer, messages, temperature, max_tokens)


def stream_and_speak(
    model,
    tokenizer,
    messages: list[dict],
    temperature: float = 0.1,
    max_tokens: int = 80,
    on_words=None,
    word_buffer: int = 4,
) -> Generator[str, None, None]:
    """SSE streaming + TTS. Calls on_words(text) when enough words accumulate,
    then flushes any remainder at the end. Yields SSE chunks for the client."""
    return _stream_impl(model, tokenizer, messages, temperature, max_tokens,
                        on_words=on_words, word_buffer=word_buffer)


def _stream_impl(
    model,
    tokenizer,
    messages: list[dict],
    temperature: float = 0.1,
    max_tokens: int = 80,
    on_words=None,
    word_buffer: int = 4,
) -> Generator[str, None, None]:
    """Core streaming: accumulate words, optionally speak, yield SSE."""
    prompt, _ = build_prompt(tokenizer, messages)
    buffer = ""

    from mlx_lm import stream_generate

    in_think = False
    for chunk in stream_generate(model, tokenizer, prompt=prompt, max_tokens=max_tokens):
        text = chunk.text

        # Suppress <think> blocks from models like Qwen
        if "<think>" in text:
            in_think = True
            continue
        if in_think:
            if "</think>" in text:
                in_think = False
            continue

        # Skip initial whitespace-only chunks
        if not text.strip():
            continue

        buffer += text

        # Speak if enough words accumulated
        if on_words:
            words = buffer.split()
            if len(words) >= word_buffer:
                to_speak = " ".join(words[:word_buffer])
                on_words(to_speak)
                buffer = " ".join(words[word_buffer:])

        payload = json.dumps({"choices": [{"delta": {"content": text}}]})
        yield f"data: {payload}\n\n"

    # Flush any remaining words at the end
    if on_words and buffer.strip():
        on_words(buffer.strip())

    yield "data: [DONE]\n\n"
