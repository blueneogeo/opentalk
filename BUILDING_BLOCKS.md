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
    agent?: string                     // <-- "tts"
    noReply?: boolean                  // context-only, no AI response
    system?: string                    // system prompt override
    parts: Array<TextPartInput | FilePartInput | ...>
  }
}
// Returns
Promise<{ info: AssistantMessage; parts: Part[] }>
```

Used to send the tts prompt + full response to the TTS agent.

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

Returns `Agent[]` from `client.app.agents()`. We use this to verify the "tts" agent exists at plugin startup.

---

## 7. Frontmatter Parsing

Agent markdown files live at:
- Global: `~/.config/opencode/agents/{name}.md`
- Project: `{directory}/.opencode/agents/{name}.md`
- Project (legacy): `{directory}/agents/{name}.md`

### Parsing a `tts` property from agent frontmatter

```typescript
const content = await Bun.file(agentPath).text()
const match = content.match(/^tts:\s*(.*)$/m)
if (match) return match[1].trim()
return null
```

Regex `/^tts:\s*(.*)$/m` — only matches `tts:` at start of line. Does NOT match indented or commented lines.

**Tested and verified** against all agent files on this system.

### Example agent with `tts`

```markdown
---
description: Primary chat agent
mode: primary
tts: Summarize what you just did in one conversational sentence
---
You are a helpful chat agent...
```

---

## 8. TTS Engine (macOS `say`)

### Basic usage from Bun

```typescript
// Fire-and-forget (non-blocking)
Bun.spawn(["say", "-v", "Samantha", text])

// Via stdin (for long text, avoids arg length limits)
const proc = Bun.spawn(["say", "-v", "Samantha"], { stdin: "pipe" })
proc.stdin.write(text)
proc.stdin.end()

// With custom rate (words per minute, default ~180)
Bun.spawn(["say", "-v", "Samantha", "-r", "200", text])
```

### Features

- Graceful fallback — if voice not found, `say` uses system default (exit 0)
- Supports `--input-file=file` and stdin piping
- Supports rate control (`-r`)
- Available voices: `say -v "?"` lists all (Samantha is a good default for English)
- Special chars (quotes, em-dashes, apostrophes) work fine

### Abort/cancel

```typescript
const proc = Bun.spawn(["say", ...])
proc.kill()  // stop speaking immediately
```

---

## 9. OpenTalk Plugin Logic (Pseudocode)

```typescript
// Track which agent is active for each session
const sessionAgentMap = new Map<string, string>()

// Cache of tts instructions per agent (read once on idle, cached)
const ttsCache = new Map<string, string | null>()

return {
  "chat.message": async (input, output) => {
    // Record which agent handles this session
    if (input.agent) {
      sessionAgentMap.set(input.sessionID, input.agent)
    }
  },

  event: async ({ event }) => {
    if (event.type !== "session.idle") return

    const { sessionID } = event.properties
    const agentName = sessionAgentMap.get(sessionID)
    if (!agentName) return

    // 1. Get tts instruction for this agent (with caching)
    let tts = ttsCache.get(agentName)
    if (tts === undefined) {
      tts = getTtsFromAgentFile(agentName)
      ttsCache.set(agentName, tts)
    }
    if (!tts) return

    // 2. Get the session's messages
    const msgs = await client.session.messages({ path: { id: sessionID } })
    
    // 3. Extract assistant's text response
    const assistantMsgs = msgs.data.filter(m => m.info.role === "assistant")
    const lastAssistant = assistantMsgs[assistantMsgs.length - 1]
    const responseText = lastAssistant.parts
      .filter(p => p.type === "text")
      .map(p => (p as TextPart).text)
      .join("\n")
    if (!responseText) return

    // 4. Create/get TTS session and send prompt
    const ttsSession = await client.session.create({ body: { title: "OpenTalk" } })
    const ttsResponse = await client.session.prompt({
      path: { id: ttsSession.data.id },
      body: {
        agent: "tts",
        parts: [
          { type: "text", text: `Instruction: ${tts}\n\nResponse to summarize:\n${responseText}` }
        ]
      }
    })

    // 5. Extract TTS agent's spoken summary
    const spokenText = ttsResponse.data.parts
      .filter(p => p.type === "text")
      .map(p => (p as TextPart).text)
      .join("\n")

    // 6. Speak it (fire-and-forget)
    if (spokenText) {
      Bun.spawn(["say", "-v", "Samantha", spokenText])
    }
  }
}
```

### Key design decisions

| Decision | Reason |
|----------|--------|
| Track agent via `chat.message` hook + Map | `session.idle` event doesn't carry agent info; `UserMessage.agent` does |
| Cache `tts` instructions per agent | Don't read the file on every idle event |
| Create a new TTS session per summary | Clean isolation; no stale context |
| `Bun.spawn` for TTS (fire-and-forget) | Non-blocking, don't wait for speech to finish |
| `client` comes from `PluginInput` | Plugin already has a connected client; no need to create a new one |
| Filter `parts` for `type === "text"` | Assistant messages have many part types (tool, step-start, etc.) |

### Edge Cases Handled

| Case | Handling |
|------|----------|
| Agent has no `tts` property | Skip silently |
| Agent file doesn't exist | Return null, cache, skip |
| TTS agent doesn't exist | Log warning at startup, skip all TTS |
| `say` command fails | Fire-and-forget, no crash |
| Assistant response is empty | Skip (return early after checking) |
| Subagent sessions (agent is undefined) | Skip in `chat.message` hook |
| Long response text | `say` handles arbitrary length; use stdin if needed |
| User interrupts speech | `proc.kill()` on the spawned process |
