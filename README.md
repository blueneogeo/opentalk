# OpenTalk

An OpenCode extension that gives agents a spoken voice — without reading out their entire responses.

## The Problem

OpenCode model responses can be long. Having the full answer read aloud via TTS would be painfully slow and impractical. A simple "bleep" sound when a response is ready isn't helpful — you still have to look at the screen to know what happened.

## The Solution

OpenTalk lets you define a **per-agent spoken summary instruction**. After the main agent finishes its work, a dedicated **TTS agent** receives that instruction plus the full response, generates a short conversational summary, and pipes it to a TTS engine. Now you hear *"I just added a dark mode toggle"* instead of a bleep — and you only need to look at the screen if the summary isn't what you expected.

## High-Level Flow

```
┌─────────────────────────────────────────────────────────┐
│                      MAIN AGENT                         │
│  Config: tts="Summarize in one conversational sentence" │
│  ...does its work, produces final response...           │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
                ┌───────────────┐
                │   EXTENSION   │
                │  (detects tts │
                │  field is set)│
                └───────┬───────┘
                        │
           ┌────────────┴────────────┐
           │                         │
           ▼                         ▼
   ┌──────────────┐         ┌──────────────┐
   │ tts prompt:  │         │  full final  │
   │ "Summarize   │         │   response   │
   │  in one..."  │         │   from main  │
   └──────┬───────┘         │    agent      │
          │                 └──────┬────────┘
          │                        │
          └────────┬───────────────┘
                   │
                   ▼
        ┌─────────────────────┐
        │     TTS AGENT       │
        │  (dedicated, own    │
        │   model/config)     │
        │                     │
        │  Input: tts prompt  │
        │    + full response  │
        │  Output: "I just    │
        │   added a dark      │
        │   mode toggle."     │
        └──────────┬──────────┘
                   │
                   ▼
        ┌─────────────────────┐
        │    TTS ENGINE       │
        │  (macOS say,        │
        │   ElevenLabs, etc.) │
        └──────────┬──────────┘
                   │
                   ▼
            🔊 "I just added
                a dark mode
                toggle."
```

## How It Works

1. **Main agent** has a `tts` field in its configuration (the prompt for the TTS agent, e.g., *"Summarize what you just did in one conversational sentence"*).
2. **Extension** detects the `tts` field is set on the current agent.
3. Extension captures the main agent's **full final response** and the **tts prompt**.
4. Extension passes both to the **TTS agent** — a dedicated, globally configured agent with its own model, system prompt, and style.
5. The TTS agent returns a **short spoken summary**.
6. Extension feeds that summary into the **TTS engine** and speaks it aloud.

## Key Design Decisions

| Decision | Reasoning |
|----------|-----------|
| **Not reading the full response** | Too slow and verbose. Short spoken summaries are actionable. |
| **Dedicated TTS agent** | Full control over model, tone, and style. Separates concerns from the main agent. |
| **`tts` prompt per main agent** | Different agents can have different summary styles (research agent, build agent, etc.). |
| **TTS agent receives full final response** | It needs enough context to generate a meaningful summary. |
| **Extension handles glue logic** | Main agent never knows TTS exists — no clutter in its context. |
| **Separate model config for TTS agent** | Can use a cheaper/faster model for summarization, independent of the main agent's model. |

## Configuration Example

```yaml
# Main agent (e.g., a code-review agent)
agent:
  name: code-reviewer
  model: claude-sonnet-4
  tts: "Give a 10-word status update in conversational style. Start with 'Hey,'"

# TTS agent (global, in extension config)
tts_agent:
  name: opentalk
  model: gpt-4o-mini
  system_prompt: |
    You are a concise spoken assistant. The user is blind or not looking at the screen.
    Summarize the response as requested by the tts instruction. Be brief, natural, and conversational.
    Never output markdown, code, or lists. One or two short sentences max.
  tts_engine: say  # macOS built-in, or ElevenLabs, OpenAI TTS, etc.
```

## Status

Early specification phase. Implementation not yet started.
