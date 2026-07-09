import type { Plugin } from "@opencode-ai/plugin"
import { join } from "node:path"
import { homedir, tmpdir } from "node:os"
import { readFileSync, existsSync, writeFileSync } from "node:fs"

// ── Types ──

interface TtsConfig {
  engine: "say" | "openrouter"
  model: string
  voice: string
  speed: number
  responseFormat: "mp3" | "pcm"
  apiKey?: string
  baseUrl?: string
}

type SpeakDirective =
  | { type: "instruction"; value: string }   // summarize via speak agent
  | { type: "full" }                          // speak the response raw

// ── Inline YAML parser for the tts block (avoids external dependency) ──

function parseTtsBlock(frontmatter: string): Record<string, string> | null {
  const lines = frontmatter.split("\n")
  let inTts = false
  const result: Record<string, string> = {}

  for (const line of lines) {
    if (line.trimStart().startsWith("tts:")) { inTts = true; continue }
    if (!inTts) continue
    // Exit tts block when we hit a non-indented, non-empty, non-comment line
    if (line.length > 0 && line[0] !== " " && line[0] !== "\t" && line[0] !== "#") break
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    const m = trimmed.match(/^([\w_]+):\s*(.*)$/)
    if (m) result[m[1]] = m[2]
  }

  return Object.keys(result).length > 0 ? result : null
}

// ── Plugin ──

export const OpenTalkPlugin: Plugin = async ({ client, directory }) => {
  try {

  const AGENT_NAME = "speak"

  // ── Global state ──
  let speakEnabled = true                     // /toggle-speak flips this
  const sessionAgent = new Map<string, string>()
  const speakDirectiveCache = new Map<string, SpeakDirective | null>()

  // ── Lazy-loaded TTS config (never blocks startup) ──
  let _ttsConfig: TtsConfig | null = null
  let _ttsLoading = false

  // ── Resolve ${VAR_NAME} from environment ──
  const resolveEnv = (value: string): string => {
    const m = value.match(/^\$\{(.+)\}$/)
    return m ? (process.env[m[1]] ?? "") : value
  }

  // ── Load TTS config from speak.md frontmatter (called lazily) ──
  const loadTtsConfig = async (): Promise<TtsConfig> => {
    const defaultConfig: TtsConfig = {
      engine: "say",
      model: "hexgrad/kokoro-82m",
      voice: "af_bella",
      speed: 1.0,
      responseFormat: "mp3",
    }

    const paths = [
      join(directory, ".opencode", "agents", "speak.md"),
      join(directory, "agents", "speak.md"),
      join(homedir(), ".config", "opencode", "agents", "speak.md"),
    ]

    // Phase 1: read the file (sync, no network)
    let ttsBlock: Record<string, string> | null = null
    for (const p of paths) {
      try {
        if (!existsSync(p)) continue
        const content = readFileSync(p, "utf-8")
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
        if (!fmMatch) continue
        const block = parseTtsBlock(fmMatch[1])
        if (block) { ttsBlock = block; break }
      } catch { /* try next path */ }
    }

    if (!ttsBlock) return defaultConfig

    const config: TtsConfig = {
      engine: (ttsBlock.engine as TtsConfig["engine"]) ?? defaultConfig.engine,
      model: ttsBlock.model ?? defaultConfig.model,
      voice: ttsBlock.voice ?? defaultConfig.voice,
      speed: Number(ttsBlock.speed) || defaultConfig.speed,
      responseFormat: (ttsBlock.response_format as TtsConfig["responseFormat"]) ?? defaultConfig.responseFormat,
    }

    // Phase 2: resolve provider credentials (may involve network)
    if (ttsBlock.api_provider) {
      try {
        const providers = await client.config.providers()
        const data = (providers as any).data ?? providers
        const list = data.providers ?? data ?? []
        const provider = Array.isArray(list)
          ? list.find((p: any) => p.id === ttsBlock.api_provider)
          : null
        if (provider) {
          config.baseUrl = provider.options?.baseURL
          if (provider.key) config.apiKey = provider.key
        }
      } catch { /* provider resolution failed */ }
    }

    // Fallback: direct api_key / base_url in speak.md
    if (!config.apiKey && ttsBlock.api_key) {
      config.apiKey = resolveEnv(ttsBlock.api_key)
    }
    if (!config.baseUrl && ttsBlock.base_url) {
      config.baseUrl = ttsBlock.base_url
    }

    // Fallback: try well-known env vars
    if (!config.apiKey) {
      config.apiKey = process.env.OPENROUTER_API_KEY
    }

    // If no API key resolved, fall back to say
    if (config.engine !== "say" && !config.apiKey) {
      config.engine = "say"
    }

    return config
  }

  // ── Get or load TTS config (never blocks if already loaded) ──
  const getTtsConfig = async (): Promise<TtsConfig> => {
    if (_ttsConfig) return _ttsConfig

    if (_ttsLoading) {
      // Wait for in-flight load to complete
      while (!_ttsConfig) {
        await new Promise(r => setTimeout(r, 50))
      }
      return _ttsConfig
    }

    _ttsLoading = true
    try {
      _ttsConfig = await loadTtsConfig()
    } catch {
      _ttsConfig = { engine: "say", model: "", voice: "", speed: 1.0, responseFormat: "mp3" }
    }
    return _ttsConfig
  }

  // ── Read speak directive from agent .md files ──
  const getSpeakDirective = (agentName: string): SpeakDirective | null => {
    const cached = speakDirectiveCache.get(agentName)
    if (cached !== undefined) return cached

    const paths = [
      join(directory, ".opencode", "agents", `${agentName}.md`),
      join(directory, "agents", `${agentName}.md`),
      join(homedir(), ".config", "opencode", "agents", `${agentName}.md`),
    ]

    for (const p of paths) {
      try {
        if (!existsSync(p)) continue
        const content = readFileSync(p, "utf-8")
        const match = content.match(/^speak:\s*(.*)$/m)
        if (!match) {
          speakDirectiveCache.set(agentName, null)
          return null
        }
        const value = match[1].trim()
        const directive: SpeakDirective =
          value === "true"
            ? { type: "full" }
            : { type: "instruction", value }
        speakDirectiveCache.set(agentName, directive)
        return directive
      } catch { /* try next */ }
    }

    speakDirectiveCache.set(agentName, null)
    return null
  }

  // ── Extract assistant text from session ──
  const extractResponseText = async (sessionID: string): Promise<string | null> => {
    try {
      const msgs = await client.session.messages({ path: { id: sessionID } })
      const data = (msgs as any).data ?? msgs
      if (!Array.isArray(data)) return null
      const assistantMessages = data.filter((m: any) => m.info?.role === "assistant")
      if (assistantMessages.length === 0) return null
      const lastMsg = assistantMessages[assistantMessages.length - 1]
      const text = (lastMsg.parts ?? [])
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join("\n").trim()
      return text || null
    } catch { return null }
  }

  // ── TTS engines ──

  const speakSay = (text: string): void => {
    Bun.spawn(["say", "-v", "Samantha", "-r", "200", text])
  }

  const speakOpenRouter = async (cfg: TtsConfig, text: string): Promise<void> => {
    const { apiKey, baseUrl, model, voice, speed, responseFormat } = cfg
    const url = `${baseUrl ?? "https://openrouter.ai/api/v1"}/audio/speech`

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: text,
        voice,
        speed,
        response_format: responseFormat,
      }),
    })

    if (!res.ok) throw new Error(`TTS API returned ${res.status}`)

    const buf = Buffer.from(await res.arrayBuffer())
    const tmp = join(tmpdir(), `opentalk-${Date.now()}.mp3`)
    writeFileSync(tmp, buf)
    Bun.spawn(["afplay", tmp])
  }

  const doSpeak = async (text: string): Promise<void> => {
    if (!text.trim()) return
    try {
      const cfg = await getTtsConfig()
      if (cfg.engine === "openrouter" && cfg.apiKey) {
        await speakOpenRouter(cfg, text)
      } else {
        speakSay(text)
      }
    } catch { /* fail silently */ }
  }

  // ── Helper: inject visible message into session ──
  const injectMessage = async (sessionID: string, text: string): Promise<void> => {
    try {
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: true,
          parts: [{ type: "text" as const, text }],
        },
      })
    } catch { /* best effort */ }
  }

  // ── Hooks ──

  return {
    // Track agent + intercept /speak and /toggle-speak
    "chat.message": async (input, output) => {
      // Check for built-in commands in the message text
      const textParts = output.parts.filter((p: any) => p.type === "text")
      const fullText = textParts.map((p: any) => p.text).join(" ")

      if (fullText.startsWith("/toggle-speak")) {
        speakEnabled = !speakEnabled
        output.parts = [{
          type: "text",
          text: `🔊 Spoken summaries ${speakEnabled ? "enabled" : "disabled"}`,
        } as any]
        return
      }

      if (fullText.startsWith("/speak ")) {
        const speakText = fullText.slice("/speak ".length).trim()
        if (speakText) {
          await doSpeak(speakText)
          const preview = speakText.length > 80 ? speakText.slice(0, 77) + "..." : speakText
          output.parts = [{ type: "text", text: `🔊 Spoke: "${preview}"` } as any]
        } else {
          output.parts = [{ type: "text", text: "Usage: /speak <text to speak>" } as any]
        }
        return
      }

      // Normal message — track agent for session.idle handler
      if (input.agent) {
        sessionAgent.set(input.sessionID, input.agent)
      }
    },

    // On session idle, summarize + speak
    event: async ({ event }) => {
      if (!speakEnabled) return
      if (event.type !== "session.idle") return

      const { sessionID } = event.properties
      const agentName = sessionAgent.get(sessionID)
      if (!agentName || agentName === AGENT_NAME) return

      const directive = getSpeakDirective(agentName)
      if (!directive) return

      const responseText = await extractResponseText(sessionID)
      if (!responseText) return

      // speak: true — speak the full response raw, no summarization
      if (directive.type === "full") {
        const truncated = responseText.length > 1000
          ? responseText.slice(0, 997) + "..."
          : responseText
        doSpeak(truncated)
        await injectMessage(sessionID, `🔊 ${truncated}`)
        return
      }

      // speak: "..." — summarize via speak agent
      const instruction = directive.value
      try {
        const ttsSession = await client.session.create({ body: { title: "OpenTalk" } })
        const ttsResult = await client.session.prompt({
          path: { id: ttsSession.data.id },
          body: {
            agent: AGENT_NAME,
            parts: [{
              type: "text",
              text: `Instruction: ${instruction}\n\nAssistant response to summarize:\n${responseText}`,
            }],
          },
        })

        const data = (ttsResult as any).data ?? ttsResult
        const parts = data.parts ?? []
        const spoken = parts
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text)
          .join(" ").trim()

        if (spoken) {
          doSpeak(spoken)
          await injectMessage(sessionID, `🔊 ${spoken}`)
        }

        try { await client.session.delete({ path: { id: ttsSession.data.id } }) } catch {}
      } catch { /* fail silently */ }
    },
  }

  } catch {
    // If ANYTHING in setup fails, return empty hooks.
    // OpenCode continues working; the plugin is simply disabled.
    return {}
  }
}
