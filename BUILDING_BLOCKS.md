# OpenTalk — Building Blocks Reference

All types, APIs, and constructs needed to build the OpenTalk plugin.
Everything below has been verified against `@opencode-ai/sdk@1.17.16` and `@opencode-ai/plugin@1.17.16`.

---

## 1. Plugin Entry Point

```typescript
import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin"

export const OpenTalkPlugin: Plugin = async (input: PluginInput) => {
  return {
    // hooks here
  }
}
```

### PluginInput (what the plugin receives)

```typescript
type PluginInput = {
  client: OpencodeClient          // SDK client (REST API)
  project: Project                 // Current project info
  directory: string                // Working directory
  worktree: string                 // Git worktree root
  serverUrl: URL                   // Server URL
  $: BunShell                      // Bun Shell (for running commands)
}
```

`client` is what we use for all API calls (session operations, agent listing, etc.).

---

## 2. Hooks We Need

From the `Hooks` interface — the plugin returns an object with any of these:

```typescript
interface Hooks {
  event?: (input: { event: Event }) => Promise<void>
  "chat.message"?: (input: { sessionID, agent?, model?, messageID?, variant? }, output: { message, parts }) => Promise<void>
  // ... plus others we don't need
}
```

### `chat.message` hook — track which agent is active

Fires when a new user message is created. We use this to build a `Map<sessionID, agentName>`.

```typescript
"chat.message"?: (input: {
    sessionID: string
    agent?: string          // <-- The agent handling this message
    model?: { providerID: string; modelID: string }
    messageID?: string
    variant?: string
}, output: {
    message: UserMessage
    parts: Part[]
}) => Promise<void>
```

**Important**: The `agent` field may be `undefined` (e.g., for subagent sessions). We skip those.

### `event` hook — listen for `session.idle`

```typescript
event?: (input: { event: Event }) => Promise<void>
```

Used to detect when a session finishes and trigger the TTS pipeline.

---

## 3. Event Types (from `@opencode-ai/sdk`)

### `EventSessionIdle` — the trigger

```typescript
type EventSessionIdle = {
  type: "session.idle"
  properties: { sessionID: string }   // <-- only sessionID, no agent info
}
```

This is why we need the `chat.message` hook to track agent names separately.

### `Event` — the full union type

```typescript
type Event = EventSessionIdle | EventSessionStatus | EventSessionCreated 
  | EventSessionUpdated | EventSessionDeleted | EventMessageUpdated 
  | EventMessagePartUpdated | EventTodoUpdated | EventPermissionUpdated
  | EventSessionCompacted | EventFileEdited | EventCommandExecuted
  | EventSessionError | EventSessionDiff | ...and many more
```

We filter by `event.type === "session.idle"`.

---

## 4. Session API (via `client.session`)

### `session.messages()` — get messages for a session

```typescript
// Input
{ path: { id: string }, query?: { directory?: string, limit?: number } }
// Returns
Promise<Array<{ info: Message; parts: Part[] }>>
```

Used to get the assistant's final response when session goes idle.

### `session.prompt()` — send a prompt and get AI response

```typescript
// Input
{
  path: { id: string },
  body: {
    messageID?: string
    model?: { providerID: string; modelID: string }
    agent?: string                     // <-- "speak"
    noReply?: boolean                  // context-only, no AI response
    system?: string                    // system prompt override
    parts: Array<TextPartInput | FilePartInput | ...>
  }
}
// Returns
Promise<{ info: AssistantMessage; parts: Part[] }>
```

Used to send the speak prompt + full response to the speak agent.

---

## 5. Message / Part Types

### `Message` — user or assistant message

```typescript
type Message = UserMessage | AssistantMessage

type UserMessage = {
  id: string; sessionID: string
  role: "user"
  agent: string                    // <-- the agent that handled it
  model: { providerID: string; modelID: string }
  system?: string
  time: { created: number }
  tools?: { [key: string]: boolean }
  summary?: { title?, body?, diffs: FileDiff[] }
}

type AssistantMessage = {
  id: string; sessionID: string
  role: "assistant"
  parentID: string
  modelID: string; providerID: string
  mode: string
  cost: number
  tokens: { input, output, reasoning, cache: { read, write } }
  finish?: string
  error?: ProviderAuthError | UnknownError | MessageOutputLengthError | ...
  time: { created: number; completed?: number }
  path: { cwd: string; root: string }
}
```

### `Part` — content within a message

Key part types we care about:

```typescript
type Part = TextPart | ReasoningPart | FilePart | ToolPart 
  | StepStartPart | StepFinishPart | ... // many more

type TextPart = {
  id: string; sessionID: string; messageID: string
  type: "text"
  text: string                         // <-- the actual text content
  synthetic?: boolean; ignored?: boolean
  time?: { start, end? }
}

type ToolPart = {
  id: string; type: "tool"
  tool: string; callID: string
  state: ToolState
}
```

**To extract assistant response**: filter parts for `type === "text"` and concatenate `text` fields.

---

## 6. Agent Types

### `Agent` — as returned by `client.app.agents()`

```typescript
type Agent = {
  name: string
  description?: string
  mode: "subagent" | "primary" | "all"
  builtIn: boolean
  topP?: number
  temperature?: number
  color?: string
  permission: {
    edit: "ask" | "allow" | "deny"
    bash: { [key: string]: "ask" | "allow" | "deny" }
    webfetch?: "ask" | "allow" | "deny"
    doom_loop?: "ask" | "allow" | "deny"
    external_directory?: "ask" | "allow" | "deny"
  }
  model?: { modelID: string; providerID: string }
  prompt?: string
  tools: { [key: string]: boolean }
  options: { [key: string]: unknown }
  maxSteps?: number
}
```

Returns `Agent[]` from `client.app.agents()`. We use this to verify the "speak" agent exists at plugin startup.

---

## 7. Frontmatter Parsing

Agent markdown files live at:
- Global: `~/.config/opencode/agents/{name}.md`
- Project: `{directory}/.opencode/agents/{name}.md`
- Project (legacy): `{directory}/agents/{name}.md`

### Parsing the `speak:` block from frontmatter

The `speak:` section uses a nested YAML structure. `parseSpeakBlock()` in `config.ts` parses it:

```
speak:
  enabled: true              # boolean
  process: true              # boolean — summarization mode
  instruction: "Summarize"   # string — prompt for speak subagent
  model: opencode-go/...     # string — LLM model for summarization
  voice:                     # sub-block — TTS settings
    provider: local          # "say" | "local" | provider-id
    model: hexgrad/...       # optional — TTS model (API providers only)
    voice: af_bella          # voice identifier
    speed: 1.0               # playback speed
    response_format: mp3     # audio format
```

The parser:
1. Finds the `speak:` line at indent level 0
2. Reads indented keys (`enabled:`, `process:`, `instruction:`, `model:`)
3. When it hits `voice:`, enters a sub-block and reads keys at the next indent level
4. Exits the voice sub-block when indent returns to speak level
5. Exits the speak block when indent returns to 0

### Example base config in `speak.md`:

```yaml
---
mode: subagent
hidden: true
temperature: 0.1

speak:
  enabled: false
  process: true
  instruction: Summarize in one conversational sentence
  model: opencode-go/deepseek-v4-flash
  voice:
    provider: local
    voice: af_bella
    speed: 1.0
---
You are the assistant's voice...
```

### Example agent override:

```yaml
---
mode: primary
speak:
  enabled: true
---
```

The agent inherits all defaults from `speak.md` — it just opts in. To customize:

```yaml
---
mode: primary
speak:
  enabled: true
  instruction: Tell me what you just did in pirate speak
  voice:
    provider: say
---
```

### Config resolution flow:

1. `parseSpeakBlock(frontmatter)` → `ParsedSpeakBlock` (raw strings)
2. `toSpeakConfig(raw)` → `DeepPartial<SpeakConfig>` (typed, partial)
3. `mergeSpeakConfig(base, agent)` → `SpeakConfig` (resolved, all fields filled)
4. `resolveVoiceCredentials(voice)` → `VoiceConfig` (with API keys resolved, or fallback to `say`)

### Deep merge:

- Agent fields override base fields (nullish coalescing)
- Voice sub-fields also merge independently — e.g., overriding `voice.speed` doesn't lose `voice.provider`

---

## 8. Voice Engines

### Engine dispatch (by `provider`)

```
voice.provider
  "say"     → sayEngine      (macOS `say` command)
  "local"   → kokoroEngine   (localhost:8765 HTTP server)
  <other>   → openrouterEngine (resolves via OpenCode providers, /v1/audio/speech)
```

### VoiceConfig type

```typescript
interface VoiceConfig {
  provider: string
  model?: string
  voice?: string
  speed?: number
  responseFormat?: "mp3" | "pcm"
  apiKey?: string
  baseUrl?: string
}
```

### Say engine (macOS built-in)

```typescript
const voice = config.voice || "Samantha"
const rate = Math.round((config.speed ?? 1.0) * 200).toString()
Bun.spawn(["say", "-v", voice, "-r", rate, text])
```

**Features**: Graceful fallback (if voice not found, uses system default). No API key needed. Supports rate control via `-r`. Available voices: `say -v "?"`.

### Kokoro engine (local server)

```typescript
fetch("http://127.0.0.1:8765/speak", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text, voice: config.voice || "af_bella" }),
})
```

Requires the local Python server running (`build.sh start`). No API key needed. Voice parameter supported; speed is not.

### OpenRouter engine (API)

```typescript
fetch(`${baseUrl ?? "https://openrouter.ai/api/v1"}/audio/speech`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model, input: text, voice, speed, response_format: responseFormat,
  }),
})
```

Downloads MP3 audio, plays via `afplay`, cleans up temp file. Credentials resolved from OpenCode provider config or `$OPENROUTER_API_KEY`.

---

## 9. OpenTalk Plugin Logic (Pseudocode)

```typescript
// Track which agent is active for each session
const sessionAgentMap = new Map<string, string>()

// Speak config resolver (base + agent merge, cached per agent)
const { getSpeakConfig, getVoiceConfig } = createSpeakConfigResolver({
  directory,
  resolveProvider: async (providerId) => {
    // Look up in OpenCode provider registry
    const providers = await client.config.providers()
    const provider = providers.data.providers.find(p => p.id === providerId)
    return provider ? { baseUrl: provider.options.baseURL, apiKey: provider.key } : null
  }
})

return {
  "chat.message": async (input, output) => {
    // Record which agent handles this session
    if (input.agent) {
      sessionAgentMap.set(input.sessionID, input.agent)
    }
    // Handle /set-speak on|off and /speak <text> commands
  },

  event: async ({ event }) => {
    if (event.type !== "session.idle") return

    const { sessionID } = event.properties
    const agentName = sessionAgentMap.get(sessionID)
    if (!agentName) return

    // 1. Resolve speak config for this agent (base + agent merge, cached)
    const config = await getSpeakConfig(agentName)
    if (!config || !config.enabled) return

    // 2. Get the session's messages and extract assistant text
    const msgs = await client.session.messages({ path: { id: sessionID } })
    const assistantMsgs = msgs.data.filter(m => m.info.role === "assistant")
    const responseText = assistantMsgs[assistantMsgs.length - 1].parts
      .filter(p => p.type === "text")
      .map(p => p.text).join("\n")

    // 3. Mode: process determines summarization vs raw
    if (!config.process) {
      // Raw passthrough — speak the response directly
      doSpeak(responseText, config.voice)
      await injectMessage(spokenText)
      return
    }

    // 4. Summarization mode — spawn speak subagent
    const ttsSession = await client.session.create({ body: { title: "OpenTalk" } })
    const ttsResult = await client.session.prompt({
      path: { id: ttsSession.data.id },
      body: {
        agent: "speak",
        parts: [{
          type: "text",
          text: `Instruction: ${config.instruction}\n\nAssistant response to summarize:\n${responseText}`,
        }],
      },
    })

    // 5. Extract spoken summary and play it
    const spokenText = ttsResult.data.parts
      .filter(p => p.type === "text")
      .map(p => p.text).join(" ").trim()

    if (spokenText) {
      doSpeak(spokenText, config.voice)
      await injectMessage(spokenText)
    }

    // 6. Cleanup
    await client.session.delete({ path: { id: ttsSession.data.id } })
  }
}
```

### Key design decisions

| Decision | Reason |
|----------|--------|
| Track agent via `chat.message` hook + Map | `session.idle` event doesn't carry agent info; `UserMessage.agent` does |
| Base defaults + per-agent overrides | `speak.md` sets global defaults; agents individually opt in and customize |
| Deep merge (field-level) | Voice fields merge independently — override `voice` without losing `provider` |
| Cache resolved config per agent | Don't re-parse/merge on every idle event |
| `process` boolean controls mode | `true` = subagent summarize, `false` = raw. Config-driven, not code-driven |
| Create a new speak session per summary | Clean isolation; no stale context |
| Fire-and-forget for TTS | Non-blocking, don't wait for speech to finish |
| `client` comes from `PluginInput` | Plugin already has a connected client; no need to create a new one |
| Filter `parts` for `type === "text"` | Assistant messages have many part types (tool, step-start, etc.) |

### Edge Cases Handled

| Case | Handling |
|------|----------|
| Agent has no `speak` section | Silent — no speaking for this agent |
| Agent has `speak.enabled: false` | Silent — explicit opt-out |
| `speak.md` not found | Hardcoded defaults (say, noop instruction) |
| Voice provider not found | Falls back to `say` |
| TTS agent doesn't exist | Log warning, skip |
| `say` command fails | Fire-and-forget, no crash |
| Assistant response is empty | Skip (return early after checking) |
| Subagent sessions (agent is undefined) | Skip in `chat.message` hook |
| Long response text | Truncated to 1000 chars in raw mode; speak subagent handles summarization |
| Speak agent recursion | Speak agent name is hard-coded and skipped |
