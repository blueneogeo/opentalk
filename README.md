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

1. **Agent markdown** has a `speak` property in its YAML frontmatter (the prompt for the speak agent).
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

No commands to run, no configuration needed beyond the `speak` line. Different agents get different instructions:

```yaml
# chat agent — conversational summary
speak: "Summarize what you just said in one conversational sentence"

# build agent — status update
speak: "Give a 10-word status update on what you just did"

# plan agent — key finding
speak: "In one sentence, tell me the key finding or recommendation from your analysis"
```

## Speak Agent

A dedicated hidden subagent at `~/.config/opencode/agents/speak.md`. Uses a fast/cheap model. User can override by placing their own `speak.md` in the same directory — the installer won't overwrite existing files.

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
