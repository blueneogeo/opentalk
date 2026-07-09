import type { Plugin } from "@opencode-ai/plugin"
import { join } from "node:path"
import { homedir, tmpdir } from "node:os"
import { readFileSync, existsSync, writeFileSync } from "node:fs"
import { parse as parseYaml } from "yaml"

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

// ── Plugin ──

export const OpenTalkPlugin: Plugin = async ({ client, directory }) => {

  const AGENT_NAME = "speak"

  // ── Global state ──
  let speakEnabled = true                     // /toggle-speak flips this
  const sessionAgent = new Map<string, string>()
  const speakCache = new Map<string, string | null>()

  // ── Resolve ${VAR_NAME} from environment ──
  const resolveEnv = (value: string): string => {
    const m = value.match(/^\$\{(.+)\}$/)
    return m ? (process.env[m[1]] ?? "") : value
  }

  // ── Load TTS config from speak.md frontmatter ──
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

    let ttsBlock: any = null

    for (const p of paths) {
      try {
        if (!existsSync(p)) continue
        const content = readFileSync(p, "utf-8")
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
        if (!fmMatch) continue
        const fm = parseYaml(fmMatch[1]) as any
        if (fm?.tts) {
          ttsBlock = fm.tts
          break
        }
      } catch { /* try next path */ }
    }

    if (!ttsBlock) return defaultConfig

    const config: TtsConfig = {
      engine: ttsBlock.engine ?? "say",
      model: ttsBlock.model ?? defaultConfig.model,
      voice: ttsBlock.voice ?? defaultConfig.voice,
      speed: ttsBlock.speed ?? defaultConfig.speed,
      responseFormat: ttsBlock.response_format ?? defaultConfig.responseFormat,
    }

    // Resolve provider credentials
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
          // Provider key might be resolved from env or set directly
          if (provider.key) config.apiKey = provider.key
        }
      } catch { /* provider resolution failed */ }
    }

    // Fallback: direct api_key / base_url in speak.md
    if (!config.apiKey && ttsBlock.api_key) {
      config.apiKey = resolveEnv(String(ttsBlock.api_key))
    }
    if (!config.baseUrl && ttsBlock.base_url) {
      config.baseUrl = String(ttsBlock.base_url)
    }

    // Fallback: try well-known env vars for the provider
    if (!config.apiKey && config.baseUrl?.includes("openrouter.ai")) {
      config.apiKey = process.env.OPENROUTER_API_KEY
    }
    if (!config.apiKey && config.engine !== "say") {
      config.apiKey = process.env.OPENROUTER_API_KEY
    }

    // If no API key resolved, fall back to say
    if (config.engine !== "say" && !config.apiKey) {
      config.engine = "say"
    }

    return config
  }

  const ttsConfig = await loadTtsConfig()

  // ── Read speak instruction from agent .md files ──
  const getSpeakInstruction = (agentName: string): string | null => {
    const cached = speakCache.get(agentName)
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
        const result = match ? match[1].trim() : null
        speakCache.set(agentName, result)
        return result
      } catch { /* try next */ }
    }

    speakCache.set(agentName, null)
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

  const speakOpenRouter = async (text: string): Promise<void> => {
    const { apiKey, baseUrl, model, voice, speed, responseFormat } = ttsConfig
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
      if (ttsConfig.engine === "openrouter" && ttsConfig.apiKey) {
        await speakOpenRouter(text)
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
    // Register /speak and /toggle-speak commands
    config: async (input: any) => {
      input.command ??= {}
      input.command["speak"] = {
        description: "Speak text aloud using OpenTalk TTS",
        template: "$ARGUMENTS",
      }
      input.command["toggle-speak"] = {
        description: "Toggle spoken summaries on or off",
        template: "",
      }
    },

    // Intercept commands
    "command.execute.before": async (input, output) => {
      if (input.command === "toggle-speak") {
        speakEnabled = !speakEnabled
        output.parts = [{
          type: "text",
          text: `🔊 Spoken summaries ${speakEnabled ? "enabled" : "disabled"}`,
        } as any]
        return
      }
      if (input.command === "speak") {
        const text = input.arguments?.trim()
        if (text) {
          await doSpeak(text)
          const preview = text.length > 80 ? text.slice(0, 77) + "..." : text
          output.parts = [{ type: "text", text: `🔊 Spoke: "${preview}"` } as any]
        } else {
          output.parts = [{ type: "text", text: "Usage: /speak <text to speak>" } as any]
        }
        return
      }
    },

    // Track which agent handles each session
    "chat.message": async (input) => {
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

      const instruction = getSpeakInstruction(agentName)
      if (!instruction) return

      const responseText = await extractResponseText(sessionID)
      if (!responseText) return

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
}
