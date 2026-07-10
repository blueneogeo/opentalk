#!/usr/bin/env python3
"""
Test the Qwen3.5 model with the exact prompt format used by the OpenTalk
plugin's "talk" agent. Feeds 4 real assistant responses and shows what
summaries the local LLM would produce.

Usage: uv run python src/gemma_test.py
"""

import time
from mlx_lm import load, stream_generate

MODEL_ID = "mlx-community/Qwen3.5-4B-4bit"

# ── From talk.md (the speak agent's system prompt) ──
SYSTEM_PROMPT = """You are the assistant's voice. The user cannot see the screen.
Your response will be read aloud by a text-to-speech engine.

You receive the assistant's full response and an instruction.
Your job: speak directly to the user in first person — a single
sentence notification of what you just did, said, or found.

Bad (talking about yourself):
  "I told you about the OpenTalk architecture and described the three TTS engines."
  "The assistant explained how the plugin works and listed the config options."

Good (talking to the user):
  "I just gave you a tour of the OpenTalk plugin and its three TTS engines."
  "I found the bug in the login handler — it was a missing import."

Rules:
- One sentence maximum, under 25 words.
- Conversational and natural — as if speaking to a person.
- Never include markdown, code, lists, or special formatting.
- Speak directly: "I just...", "I found...", "I added..."
- Never: "I told you...", "The assistant did...", "I explained..."
- Plain text only. No intro or outro — just the spoken sentence."""

# ── From talk.md frontmatter: instruction ──
INSTRUCTION = "Tell me in one conversational sentence, under 10 words"

# ── 4 real assistant responses from our conversation ──
EXAMPLES = [
    # Example 1: Architecture overview
    """OpenTalk is a TypeScript/Bun plugin for OpenCode that gives agents a voice after they complete their work.

It hooks into session.idle events, reads a speak: directive from the agent's
markdown frontmatter, generates a short summary via a dedicated "speak" subagent,
pipes it through a TTS engine, and injects the result back into the conversation.

Architecture: 10 source files covering plugin entry, config loading (YAML + env vars),
directive resolution, session injection, response suppression (intercepts globalThis.Response),
three TTS engines (macOS say, OpenRouter API, Kokoro local MLX server), and logging.

Key flow: chat.message tracks agent→session → session.idle triggers TTS →
speak:true reads full response → speak:"instruction" spawns subagent for summary →
injects "🔊 ..." result. Supports /speak <text> and toggle commands.""",

    # Example 2: Toggle command discussion
    """Here's my analysis after researching both approaches and the OpenCode docs.

Approach 1: Text-based catch (/set-speak on|off) — Viable. The reason /speak <text>
works but /toggle-speak fails: bare /word patterns get trapped by TUI command
matching, while argument-bearing patterns pass through to chat.message. The fix is
minimal — just rename to /set-speak on and /set-speak off.

Approach 2: Native OpenCode commands — Not viable. The @opencode-ai/plugin package
only exports tool — no command registration API exists. OpenCode commands always
send prompt templates to the LLM, no side-effect-only mechanism.

Recommendation: Approach 1, using the same throw+suppress pattern.""",

    # Example 3: Speech cancellation implementation
    """All green. Typecheck passed, 33 tests passed, bundle built, plugin installed.

What changed across 5 files:
- types.ts — signal?: AbortSignal added to TtsEngine.speak()
- registry.ts — tracks currentAbort; before each doSpeak, aborts previous and
  creates fresh controller
- say.ts — listens for abort on the say subprocess → kills it
- openrouter.ts — switched from fire-and-forget to await; listens for abort on
  the afplay subprocess
- kokoro.ts — accepts signal param (no logic change — server already self-interrupts)

Restart OpenCode and any new speech will immediately kill whatever's currently playing.""",

    # Example 4: LLM model research
    """Good catch — my earlier search was too shallow. The 2026 landscape is completely different.

Gemma 4 E4B (April 2026) is the top recommendation: ~3GB 4bit, 40-60 tok/s baseline
with multi-token-prediction giving a 2-3x speed boost, Apache 2.0 license. For
summarization quality it's the best in this size class — Google's instruction tuning
is top-tier.

Also found: Ternary Bonsai 4B (1.13GB, 133 tok/s), Qwen3.5-4B (2.4GB, 160 tok/s),
and SmolLM3-3B (1.73GB, ~90 tok/s). All run on MLX with kokoro-mlx (~1GB),
total footprint ~4GB — comfortable on any M-series Mac.""",
]


def build_prompt(tokenizer, response_text: str) -> str:
    """Build the exact prompt the talk agent receives."""
    user_message = (
        f"Instruction: {INSTRUCTION}\n\n"
        f"Assistant response to summarize:\n{response_text}"
    )
    return tokenizer.apply_chat_template(
        [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_message},
        ],
        tokenize=False,
        add_generation_prompt=True,
        enable_thinking=False,
    )


def main():
    print(f"Loading {MODEL_ID}...")
    t0 = time.time()
    model, tokenizer = load(MODEL_ID)
    print(f"  Loaded in {time.time() - t0:.1f}s\n")

    for i, text in enumerate(EXAMPLES, 1):
        prompt = build_prompt(tokenizer, text)
        print(f"─── Example {i} ───")
        print(f"Prompt tokens: {len(tokenizer.encode(prompt))}")
        t0 = time.time()

        full = ""
        for chunk in stream_generate(
            model, tokenizer, prompt=prompt, max_tokens=80,
        ):
            full += chunk.text

        elapsed = time.time() - t0
        print(f"Output: {full.strip()}")
        print(f"Time: {elapsed:.1f}s\n")


if __name__ == "__main__":
    main()
