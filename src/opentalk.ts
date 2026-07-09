import type { Plugin } from "@opencode-ai/plugin"
import { join } from "node:path"
import { homedir, tmpdir } from "node:os"
import { readFileSync, existsSync, writeFileSync } from "node:fs"

// ── Types ──

interface TtsConfig {
  engine: "say" | "openrouter" | "kokoro"
  model: string
  voice: string
  speed: number
  responseFormat: "mp3" | "pcm"
  apiKey?: string
  baseUrl?: string
}

type SpeakDirective =
  | { type: "instruction"; value: string }
  | { type: "full" }

function parseTtsBlock(frontmatter: string): Record<string, string> | null {
  const lines = frontmatter.split("\n")
  let inTts = false
  const result: Record<string, string> = {}

  for (const line of lines) {
    if (line.trimStart().startsWith("tts:")) { inTts = true; continue }
    if (!inTts) continue
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
  const _log = (...args: any[]) => {
    try { require("fs").appendFileSync(join(homedir(), ".opentalk", "plugin.log"), `[${new Date().toISOString()}] ${args.map(String).join(" ")}\n`) } catch {}
  }
  _log("Plugin loaded")

  let speakSuppress = false

  const OriginalResponse = globalThis.Response
  globalThis.Response = function (this: any, body?: any, init?: any) {
    if (speakSuppress) {
      let bodyStr = ""
      try {
        if (typeof body === "string") {
          bodyStr = body
        } else if (body && typeof body === "object") {
          // Object with numeric keys (0,1,2...) = char codes from Bun's Response
          const keys = Object.keys(body)
          if (keys.length > 2 && keys.every((k, i) => String(i) === k && typeof body[k] === "number")) {
            bodyStr = String.fromCharCode(...(Object.values(body) as number[]))
          } else {
            bodyStr = JSON.stringify(body)
          }
        } else {
          bodyStr = String(body ?? "")
        }
      } catch (e) { bodyStr = "[err:" + String(e) + "]" }
      _log("RESP", (init as any)?.status ?? "?", "len=" + bodyStr.length, bodyStr.slice(0, 300))
      if ((init as any)?.status >= 400) {
        // Match on the stable error type name instead of user-facing text
        if (bodyStr.includes('"name":"UnknownError"') || bodyStr.includes('"name":"InternalServerError"')) {
          _log("SUPPRESSED", bodyStr.slice(0, 200))
          return new OriginalResponse(JSON.stringify({ ok: true }), { ...(init ?? {}), status: 200 })
        }
        // Fallback: also match on known display messages
        if (bodyStr.includes("Failed to send prompt") || bodyStr.includes("Unexpected server error")) {
          _log("SUPPRESSED (message match)", bodyStr.slice(0, 200))
          return new OriginalResponse(JSON.stringify({ ok: true }), { ...(init ?? {}), status: 200 })
        }
      }
    }
    return new OriginalResponse(body, init)
  } as any
  Object.defineProperty(globalThis.Response, "prototype", { value: OriginalResponse.prototype })

  const _consoleError = console.error
  const _stdoutWrite = process.stdout.write.bind(process.stdout)
  const _stderrWrite = process.stderr.write.bind(process.stderr)
  const _fetch = globalThis.fetch

  try {

  const AGENT_NAME = "opentalk-tts"

  let speakEnabled = true
  const sessionAgent = new Map<string, string>()
  const speakDirectiveCache = new Map<string, SpeakDirective | null>()

  let _ttsConfig: TtsConfig | null = null
  let _ttsLoading = false

  const resolveEnv = (value: string): string => {
    const m = value.match(/^\$\{(.+)\}$/)
    return m ? (process.env[m[1]] ?? "") : value
  }

  const loadTtsConfig = async (): Promise<TtsConfig> => {
    const defaultConfig: TtsConfig = {
      engine: "kokoro",
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

    let ttsBlock: Record<string, string> | null = null
    for (const p of paths) {
      try {
        if (!existsSync(p)) continue
        const content = readFileSync(p, "utf-8")
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
        if (!fmMatch) continue
        const block = parseTtsBlock(fmMatch[1])
        if (block) { ttsBlock = block; break }
      } catch (err) { console.warn("[OpenTalk] failed to read config from", p, err) }
    }

    if (!ttsBlock) return defaultConfig

    const config: TtsConfig = {
      engine: (ttsBlock.engine as TtsConfig["engine"]) ?? defaultConfig.engine,
      model: ttsBlock.model ?? defaultConfig.model,
      voice: ttsBlock.voice ?? defaultConfig.voice,
      speed: Number(ttsBlock.speed) || defaultConfig.speed,
      responseFormat: (ttsBlock.response_format as TtsConfig["responseFormat"]) ?? defaultConfig.responseFormat,
    }

    if (config.engine === "openrouter") {
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
        } catch (err) { console.warn("[OpenTalk] provider resolution failed:", err) }
      }

      if (!config.apiKey && ttsBlock.api_key) {
        config.apiKey = resolveEnv(ttsBlock.api_key)
      }
      if (!config.baseUrl && ttsBlock.base_url) {
        config.baseUrl = ttsBlock.base_url
      }

      if (!config.apiKey) {
        config.apiKey = process.env.OPENROUTER_API_KEY
      }

      if (!config.apiKey) {
        config.engine = "say"
      }
    }

    return config
  }

  const getTtsConfig = async (): Promise<TtsConfig> => {
    if (_ttsConfig) return _ttsConfig

    if (_ttsLoading) {
      while (!_ttsConfig) {
        await new Promise(r => setTimeout(r, 50))
      }
      return _ttsConfig
    }

    _ttsLoading = true
    try {
      _ttsConfig = await loadTtsConfig()
    } catch (err) {
      console.warn("[OpenTalk] loading TTS config failed, falling back to say:", err)
      _ttsConfig = { engine: "say", model: "", voice: "", speed: 1.0, responseFormat: "mp3" }
    }
    return _ttsConfig
  }

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
      } catch (err) { console.warn("[OpenTalk] failed to read directive from", p, err) }
    }

    speakDirectiveCache.set(agentName, null)
    return null
  }

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
    } catch (err) { console.error("[OpenTalk] extractResponseText failed:", err); return null }
  }

  const KOKORO_URL = "http://127.0.0.1:8765"

  const speakSay = (text: string): void => {
    try {
      Bun.spawn(["say", "-v", "Samantha", "-r", "200", text])
    } catch (err) { console.error("[OpenTalk] say command failed:", err) }
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

  const speakKokoro = async (text: string, voice: string): Promise<void> => {
    const res = await fetch(`${KOKORO_URL}/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice }),
    })
    if (!res.ok) throw new Error(`Kokoro server returned ${res.status}`)
  }

  const doSpeak = async (text: string): Promise<void> => {
    if (!text.trim()) return
    const cfg = await getTtsConfig()
    if (cfg.engine === "kokoro") {
      await speakKokoro(text, cfg.voice)
    } else if (cfg.engine === "openrouter" && cfg.apiKey) {
      await speakOpenRouter(cfg, text)
    } else {
      speakSay(text)
    }
  }

  const injectMessage = async (sessionID: string, text: string): Promise<void> => {
    try {
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: true,
          parts: [{ type: "text" as const, text }],
        },
      })
    } catch (err) { console.error("[OpenTalk] injectMessage failed:", err) }
  }

  return {
    dispose: async () => {
      globalThis.Response = OriginalResponse
    },

    "chat.message": async (input, output) => {
      if (input.agent) {
        sessionAgent.set(input.sessionID, input.agent)
      }

      const textParts = output.parts.filter((p: any) => p.type === "text" && !p.synthetic && !p.ignored)
      if (textParts.length === 0) return
      const fullText = textParts.map((p: any) => p.text).join(" ").trim()

      if (fullText === "/toggle-speak") {
        speakEnabled = !speakEnabled
        speakSuppress = true
        setTimeout(() => { speakSuppress = false }, 2000)
        injectMessage(input.sessionID, `🔊 Spoken summaries ${speakEnabled ? "enabled" : "disabled"}`)
        _log("/toggle-speak — raising suppress flag")
        throw new Error("OPENTALK")
      }

      if (fullText.startsWith("/speak ")) {
        const text = fullText.slice("/speak ".length).trim()
        if (text) {
          doSpeak(text).catch((err) => {
            console.error("[OpenTalk] doSpeak failed:", err)
          })
          injectMessage(input.sessionID, `🔊 ${text}`)
        }
        speakSuppress = true
        setTimeout(() => { speakSuppress = false }, 2000)
        _log("/speak", text, "— raising suppress flag")
        throw new Error("OPENTALK")
      }
    },

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

      if (responseText.startsWith("🔊 ")) return

      if (directive.type === "full") {
        const truncated = responseText.length > 1000
          ? responseText.slice(0, 997) + "..."
          : responseText
        try { await doSpeak(truncated) } catch (err) { console.error("[OpenTalk] doSpeak failed:", err) }
        await injectMessage(sessionID, `🔊 ${truncated}`)
        return
      }

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
          try { await doSpeak(spoken) } catch (err) { console.error("[OpenTalk] doSpeak failed:", err) }
          await injectMessage(sessionID, `🔊 ${spoken}`)
        }

        try { await client.session.delete({ path: { id: ttsSession.data.id } }) } catch {}
      } catch (err) { console.error("[OpenTalk] summarization failed:", err) }
    },
  }

  } catch (err) {
    console.error("[OpenTalk] Plugin setup failed, no hooks registered:", err)
    return {}
  }
}
