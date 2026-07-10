# OpenTalk

An OpenCode plugin that gives agents a spoken voice — without reading out their entire responses.

## The Problem

OpenCode agent responses can be long. Having the full answer read aloud via TTS would be painfully slow and impractical. A simple "bleep" sound when a response is ready isn't helpful — you still have to look at the screen to know what happened.

## The Solution

OpenTalk provides a **base defaults + per-agent override** configuration model. A `speak:` section in `speak.md` defines the global defaults: summarization instruction, LLM model, voice provider. Individual agents opt in by adding `speak: { enabled: true }` to their frontmatter, optionally overriding any field. After an agent finishes, the plugin either summarizes via a dedicated **speak subagent** (`process: true`) or speaks the raw text directly (`process: false`). Output goes through your chosen voice provider (macOS `say`, local Kokoro MLX, or any OpenCode provider). The result is spoken aloud and injected as a visible `🔊` message.

## High-Level Flow

```
┌──────────────────────────────────────────────────────────────┐
│                        MAIN AGENT                            │
│  Agent .md: speak: { enabled: true }                         │
│  ...does its work, produces final response...               │
└───────────────────────┬──────────────────────────────────────┘
                        │
                        ▼  session.idle
                ┌───────────────┐
                │    PLUGIN     │
                │ resolves speak│
                │ config (base  │
                │ + agent merge)│
                └───────┬───────┘
                        │
            ┌─────────────┴─────────────┐
            │ process: true              │ process: false
            ▼                           ▼
    ┌───────────────┐          ┌───────────────┐
    │ SPEAK AGENT   │          │  Raw response │
    │ summarizes    │          │  spoken       │
    │ then speaks   │          │  directly     │
    └───────────────┘          └───────┬───────┘
            │                          │
            └──────────┬───────────────┘
                       │
                       ▼
              ┌─────────────────┐
              │  VOICE ENGINE   │
              │ say | local     │
              │ (kokoro) | API  │
              └────────┬────────┘
                       │
                       ▼
               🔊 "I just added
                   a dark mode
                   toggle."
```

## How It Works

1. **`speak.md`** defines the base defaults: `enabled`, `process`, `instruction`, `model`, and `voice` settings.
2. **Agent markdown** opts in with `speak: { enabled: true }` and optionally overrides any field.
3. **Plugin** tracks which agent handles each session via the `chat.message` hook.
4. On **`session.idle`**, the plugin resolves the agent's config by deep-merging base + agent overrides (cached per agent).
5. Plugin extracts the assistant's full text response from the session messages.
6. If `process: true` — creates a session for the **speak agent** (hidden subagent) and sends instruction + response for summarization.
7. If `process: false` — speaks the raw response text directly.
8. Result is spoken via the configured **voice provider** (`say`, `local`, or a custom provider).
9. Summary/raw text is also **injected back** into the conversation as a visible `🔊` message.
10. The speak agent session is **cleaned up** immediately after use.

## Key Design Decisions

| Decision | Reasoning |
|----------|-----------|
| **Not reading the full response** | Too slow and verbose. Short spoken summaries are actionable. |
| **Base defaults + per-agent overrides** | `speak.md` sets global defaults; agents override what they need. Clean inheritance. |
| **`process` boolean** | `true` = summarize via subagent, `false` = raw passthrough. Config, not code. |
| **Dedicated speak agent (hidden subagent)** | Full control over model, tone, and style. Separates concerns from the main agent. |
| **`speak` configuration per agent** | Different agents can have different summary styles and voice settings. |
| **Speak agent receives full final response** | Needs enough context to generate a meaningful summary. |
| **Plugin handles all glue logic** | Main agent never knows TTS exists — no clutter in its context. |
| **Separate model for speak agent** | Can use a cheaper/faster model than the main agent. |
| **Summary visible in conversation** | User can read it too, not just hear it. |
| **Loop guard** | Speak agent won't trigger itself (agent name check). |
| **Session cleanup** | Speak agent session deleted immediately after use. |
| **Local Kokoro server** | Kokoro engine requires a local Python HTTP server (`build.sh start/stop/status`). `say` and provider-based engines need no server. |

## Installation

```bash
cd opentalk
npm install    # install dependencies (esbuild, typescript, etc.)
./build.sh install
```

This builds the plugin into a single bundled file and copies:
- `dist/opentalk.js` → `~/.config/opencode/plugins/opentalk.ts`
- `agents/speak.md` → `~/.config/opencode/agents/speak.md` (preserves user overrides)
- `src/kokoro-server.py` → `~/.opentalk/kokoro-server.py`

Then restart OpenCode.

To uninstall:
```bash
./build.sh uninstall
```

## Usage

### Enabling for an agent

Add a `speak:` section to any agent's markdown frontmatter. The minimal opt-in:

```yaml
# ~/.config/opencode/agents/build.md
---
speak:
  enabled: true
---
```

This enables speaking with all defaults from `speak.md` (summarization via the speak subagent using the global instruction and model, default voice).

### Customizing per agent

Any field from the base config can be overridden:

```yaml
# Custom instruction
speak:
  enabled: true
  instruction: "Give a 10-word status update on what you just did"

# Raw passthrough — no summarization, speak full response
speak:
  enabled: true
  process: false

# Custom instruction + raw passthrough
speak:
  enabled: true
  process: false

# Custom voice for this agent
speak:
  enabled: true
  voice:
    voice: Samantha

# Different LLM model for summarization
speak:
  enabled: true
  model: opencode-go/deepseek-v4-flash
```

### Agent examples

```yaml
# chat agent — conversational summary
speak:
  enabled: true
  instruction: "Summarize what you just said in one conversational sentence"

# build agent — status update
speak:
  enabled: true
  instruction: "Give a 10-word status update on what you just did"

# plan agent — key finding
speak:
  enabled: true
  instruction: "In one sentence, tell me the key finding or recommendation from your analysis"

# any agent — speak the full response raw
speak:
  enabled: true
  process: false
```

## Speak Agent Configuration

The speak agent (`~/.config/opencode/agents/speak.md`) defines both the summarization behavior AND the voice engine via its YAML frontmatter. The `speak:` section serves as the base defaults that agents inherit from.

### `speak:` section

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `enabled` | No | `false` | Master on/off. Agents must explicitly set `enabled: true` to opt in. |
| `process` | No | `true` | `true` = summarize via speak subagent. `false` = speak raw response directly. |
| `instruction` | No | — | Prompt sent to the speak subagent for summarization. Only used when `process: true`. |
| `model` | No | `opencode-go/deepseek-v4-flash` | LLM model used by the speak subagent. Only used when `process: true`. |

### `voice:` section

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `provider` | No | `say` | `say` (macOS built-in), `local` (kokoro server on localhost:8765), or any provider ID from `opencode.json` |
| `model` | Only for API providers | — | TTS model slug (e.g. `hexgrad/kokoro-82m`). Required unless provider is `say` or `local` |
| `voice` | No | `af_bella` | Voice identifier — provider-specific. See voice tables below |
| `speed` | No | `1.0` | Playback speed (0.25–4.0). Not supported by local kokoro |
| `response_format` | No | `mp3` | Audio output: `mp3` (compressed) or `pcm` (raw). Only used by API providers |

### Voice provider behavior

| `provider` value | Engine | Credentials | Notes |
|-----------------|--------|-------------|-------|
| `say` | macOS `say` command | None needed | Built-in, always available |
| `local` | Kokoro server (localhost:8765) | None needed | Requires `build.sh start` |
| `<provider-id>` | OpenRouter-compatible TTS API | Resolved from `opencode.json` | Model field required |

### Credential resolution for API providers

When `provider` is set to a provider ID (not `say` or `local`):

1. **Looks up the provider** in `opencode.json` provider registry (matches by `.id`)
2. **Extracts** `baseURL` and `key` from the provider configuration
3. **Falls back** to `$OPENROUTER_API_KEY` environment variable if provider not found
4. If no credentials found → falls back to `provider: say`

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
speak:
  enabled: false
  process: true
  instruction: Summarize in one conversational sentence
  model: opencode-go/deepseek-v4-flash
  voice:
    provider: say
---
```

**Local Kokoro (free, high quality, no internet needed):**
```yaml
---
speak:
  enabled: false
  process: true
  instruction: Summarize in one conversational sentence
  model: opencode-go/deepseek-v4-flash
  voice:
    provider: local
    voice: af_bella
---
```
First run downloads the 86MB ONNX model. Subsequent calls are instant.

**OpenRouter with provider reference:**
```yaml
---
speak:
  enabled: false
  process: true
  instruction: Summarize in one conversational sentence
  model: opencode-go/deepseek-v4-flash
  voice:
    provider: openrouter
    model: hexgrad/kokoro-82m
    voice: af_bella
    speed: 1.0
    response_format: mp3
---
```

**High-quality option (OpenAI model via OpenRouter):**
```yaml
---
speak:
  enabled: false
  process: true
  instruction: Summarize in one conversational sentence
  model: opencode-go/deepseek-v4-flash
  voice:
    provider: openrouter
    model: openai/gpt-4o-mini-tts
    voice: nova
    speed: 1.0
    response_format: mp3
---
```

### User Overrides

Your custom `~/.config/opencode/agents/speak.md` takes priority over the shipped version. The install script won't overwrite it. This lets you change the model, voice, or LLM system prompt without touching the plugin code.

Project-level overrides are also supported: place a `speak.md` in `.opencode/agents/` within your project directory.

### Inheritance model

1. `speak.md` defines the **base defaults** (everything set to reasonable defaults, `enabled: false`)
2. Each agent adds a `speak:` section in its `.md` file
3. If an agent has **no `speak:` section**, it doesn't get spoken
4. If an agent sets `speak: { enabled: true }`, all other fields inherit from the base
5. Any field the agent sets overrides the base — **deep merge** (voice fields merge independently)
6. Process mode (`process: true/false`) determines summarization vs raw speech

## Project Structure

```
opentalk/
├── src/
│   ├── opentalk.ts              # Plugin entry point (hooks)
│   ├── types.ts                 # Shared type definitions (VoiceConfig, SpeakConfig)
│   ├── logger.ts                # Debug logging utility
│   ├── response-suppression.ts  # Error suppression workaround
│   ├── config.ts                # Speak config loading, parsing, merging, resolving
│   ├── session.ts               # Session utilities
│   ├── tts-engines/
│   │   ├── types.ts             # TTS engine interface
│   │   ├── say.ts               # macOS say engine
│   │   ├── openrouter.ts        # OpenRouter API engine
│   │   ├── kokoro.ts            # Local Kokoro engine
│   │   └── registry.ts          # Engine registry & dispatch (by provider)
│   └── kokoro-server.py         # Local Kokoro TTS server
├── agents/speak.md              # Speak agent definition + base defaults
├── tests/                       # Unit tests (33 tests)
├── build.mjs                    # esbuild bundler (→ single deployable file)
├── build.sh                     # Install / uninstall / start / stop / status
├── package.json
├── tsconfig.json
├── biome.json                   # Lint & format config
├── vitest.config.ts             # Test runner config
├── BUILDING_BLOCKS.md           # Type reference & verified building blocks
└── README.md
```
