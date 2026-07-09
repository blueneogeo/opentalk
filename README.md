# OpenTalk

An OpenCode plugin that gives agents a spoken voice — without reading out their entire responses.

## The Problem

OpenCode agent responses can be long. Having the full answer read aloud via TTS would be painfully slow and impractical. A simple "bleep" sound when a response is ready isn't helpful — you still have to look at the screen to know what happened.

## The Solution

OpenTalk lets you define a **per-agent spoken summary instruction**. After an agent finishes its work, a dedicated **speak agent** receives that instruction plus the full response, generates a short conversational summary, and pipes it through macOS `say`. The summary is also injected back into the conversation as a visible message so you can read it. Now you hear *"I just added a dark mode toggle"* — and only need to look at the screen if the summary isn't what you expected.

## High-Level Flow

```
┌──────────────────────────────────────────────────────────────┐
│                        MAIN AGENT                            │
│  Agent .md: speak="Summarize in one conversational sentence" │
│  ...does its work, produces final response...                │
└───────────────────────┬──────────────────────────────────────┘
                        │
                        ▼  session.idle
                ┌───────────────┐
                │    PLUGIN     │
                │  (reads speak │
                │  from agent   │
                │   .md file)   │
                └───────┬───────┘
                        │
           ┌────────────┴────────────┐
           │                         │
           ▼                         ▼
   ┌──────────────┐         ┌──────────────┐
   │ speak prompt │         │  full final  │
   │ "Summarize   │         │   response   │
   │  in one..."  │         │   from main  │
   └──────┬───────┘         │    agent      │
          │                 └──────┬────────┘
          │                        │
          └────────┬───────────────┘
                   │
                   ▼
        ┌─────────────────────┐
        │    SPEAK AGENT      │
        │  (hidden subagent,  │
        │  own model/config)  │
        │                     │
        │  Input: speak prompt│
        │   + full response   │
        │  Output: "I just    │
        │   added a dark      │
        │   mode toggle."     │
        └──────────┬──────────┘
                   │
         ┌─────────┴─────────┐
         │                   │
         ▼                   ▼
  ┌──────────────┐   ┌──────────────┐
  │  macOS say   │   │  🔊 injected │
  │  "Samantha"  │   │   back into  │
  └──────┬───────┘   │ conversation │
         │           └──────────────┘
         ▼
  🔊 "I just added
      a dark mode
      toggle."
```

## How It Works

1. **Agent markdown** has a `speak` property in its YAML frontmatter. Two forms:
   - `speak: "summarize..."` — the prompt for the speak agent (summarized output)
   - `speak: true` — skip summarization, speak the full response raw
2. **Plugin** tracks which agent handles each session via the `chat.message` hook.
3. On **`session.idle`**, the plugin reads the agent's `speak` instruction from its `.md` file (cached).
4. Plugin extracts the assistant's full text response from the session messages.
5. Plugin creates a session for the **speak agent** (hidden subagent) and sends the instruction + full response.
6. The speak agent returns a **short spoken summary** (one sentence, under 25 words).
7. Summary is spoken via **macOS `say`** (fire-and-forget).
8. Summary is also **injected back** into the conversation as a visible `🔊` message.
9. The speak agent session is **cleaned up** immediately so it doesn't linger.

## Key Design Decisions

| Decision | Reasoning |
|----------|-----------|
| **Not reading the full response** | Too slow and verbose. Short spoken summaries are actionable. |
| **Dedicated speak agent (hidden subagent)** | Full control over model, tone, and style. Separates concerns from the main agent. |
| **`speak` prompt per main agent** | Different agents can have different summary styles. |
| **Speak agent receives full final response** | Needs enough context to generate a meaningful summary. |
| **Plugin handles all glue logic** | Main agent never knows TTS exists — no clutter in its context. |
| **Separate model for speak agent** | Can use a cheaper/faster model than the main agent. |
| **Summary visible in conversation** | User can read it too, not just hear it. |
| **Loop guard** | Speak agent won't trigger itself (agent name check). |
| **Session cleanup** | Speak agent session deleted immediately after use. |
| **No server, no PID management** | Plugin hooks directly into OpenCode's event system. |

## Installation

```bash
cd opentalk
./build.sh install
```

This copies:
- `src/opentalk.ts` → `~/.config/opencode/plugins/opentalk.ts`
- `agents/speak.md` → `~/.config/opencode/agents/speak.md` (only if not already present — preserves user overrides)

Then restart OpenCode.

To uninstall:
```bash
./build.sh uninstall
```

## Usage

Add a `speak` property to any agent's markdown frontmatter:

```yaml
# ~/.config/opencode/agents/build.md
---
speak: "Give a 10-word status update on what you just did"
---
```

No commands to run, no configuration needed beyond the `speak` line. The `speak` property accepts two forms:

```yaml
# Summarized — goes through the speak agent for a one-sentence summary
speak: "Give a 10-word status update on what you just did"

# Full raw — speaks the entire response directly, no summarization
speak: true
```

Different agents get different instructions:

```yaml
# chat agent — conversational summary
speak: "Summarize what you just said in one conversational sentence"

# build agent — status update
speak: "Give a 10-word status update on what you just did"

# plan agent — key finding
speak: "In one sentence, tell me the key finding or recommendation from your analysis"

# any agent — speak the full response raw
speak: true
```

## Speak Agent Configuration

The speak agent (`~/.config/opencode/agents/speak.md`) defines both the summarization behavior AND the TTS engine via its YAML frontmatter. Here's the full breakdown:

### TTS Engine Settings (`tts:` block)

If the `tts:` block is absent, the plugin falls back to macOS `say`. Each field is explained below:

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `engine` | No | `say` | `say` (macOS built-in) or `openrouter` (OpenAI-compatible API) |
| `model` | No | `hexgrad/kokoro-82m` | OpenRouter TTS model slug. See [available models](https://openrouter.ai/collections/text-to-speech-models) |
| `voice` | No | `af_bella` | Voice identifier — model-specific. See voices section below |
| `speed` | No | `1.0` | Playback speed (0.25–4.0). Only OpenAI models support this; Kokoro ignores it |
| `response_format` | No | `mp3` | Audio output: `mp3` (compressed) or `pcm` (raw) |
| `api_provider` | No | — | References a provider in `opencode.json` for API key + base URL |
| `api_key` | No | — | Fallback: direct key as `${ENV_VAR}` or raw string |
| `base_url` | No | `https://openrouter.ai/api/v1` | Fallback: custom endpoint URL |

### Credential Resolution Order

The plugin resolves TTS credentials in this priority:

1. **`api_provider`** → looks up key + baseURL from `opencode.json` provider registry
2. **`api_key` + `base_url`** → direct values in speak.md (supports `${ENV_VAR}`)
3. **`$OPENROUTER_API_KEY`** → environment variable fallback
4. None found → falls back to `engine: say`

### Kokoro Voices

Kokoro uses the naming pattern `{language}{gender}_{name}`. 54 voices across 8 languages:

| Voice | Character | Language |
|-------|-----------|----------|
| `af_bella` | Warm, natural **(recommended)** | US English |
| `af_nicole` | Whisper-like, technical | US English |
| `af_sarah` | Professional | US English |
| `af_sky` | Bright | US English |
| `am_adam` | Friendly male | US English |
| `am_michael` | Deep male | US English |
| `bf_emma` | Proper | British English |
| `bf_isabella` | Soft | British English |
| `bm_george` | Formal male | British English |

Also available: Japanese, Mandarin Chinese, Spanish, French, Hindi, Italian, Brazilian Portuguese.

### OpenAI Voices

If using an OpenAI model instead: `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`.

### Configuration Examples

**macOS built-in speech only (no API key needed):**
```yaml
---
tts:
  engine: say
---
```

**OpenRouter with provider reference:**
```yaml
---
tts:
  engine: openrouter
  model: hexgrad/kokoro-82m
  voice: af_bella
  speed: 1.0
  response_format: mp3
  api_provider: openrouter
---
```

**OpenRouter with environment variable (no provider config needed):**
```yaml
---
tts:
  engine: openrouter
  model: hexgrad/kokoro-82m
  voice: af_bella
  response_format: mp3
  api_key: ${OPENROUTER_API_KEY}
---
```

**High-quality option (OpenAI model via OpenRouter):**
```yaml
---
tts:
  engine: openrouter
  model: openai/gpt-4o-mini-tts
  voice: nova
  speed: 1.0
  response_format: mp3
  api_provider: openrouter
---
```

### User Overrides

Your custom `~/.config/opencode/agents/speak.md` takes priority over the shipped version. The install script won't overwrite it. This lets you change the model, voice, or LLM system prompt without touching the plugin code.

Project-level overrides are also supported: place a `speak.md` in `.opencode/agents/` within your project directory.

## Project Structure

```
opentalk/
├── src/opentalk.ts       # The plugin
├── agents/speak.md        # Speak agent definition
├── build.sh               # Install / uninstall
├── package.json           # @opencode-ai/plugin dependency
├── tsconfig.json
├── BUILDING_BLOCKS.md     # Type reference & verified building blocks
└── README.md
```
