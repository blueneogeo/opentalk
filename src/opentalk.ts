/**
 * OpenTalk — OpenCode plugin that speaks short summaries when agents finish.
 *
 * On session.idle, reads the agent's resolved `talk:` config (base defaults
 * from talk.md deep-merged with per-agent overrides):
 * - summarize: true  → spawns the talk subagent to summarize, then speaks
 * - summarize: false → speaks the raw response text directly
 * - enabled: false → no speaking
 */
import type { Plugin } from "@opencode-ai/plugin"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { log } from "./logger"
import {
  installResponseSuppression,
  uninstallResponseSuppression,
  activateSuppression,
} from "./response-suppression"
import { createTalkConfigResolver } from "./config"
import { injectMessage } from "./session"
import { doSpeak } from "./tts-engines/registry"
import type { TalkConfig, VoiceConfig } from "./types"

const AGENT_NAME = "talk"

class OpenTalkAbortError extends Error {
  constructor() {
    super("OPENTALK")
    this.name = "OpenTalkAbortError"
  }
}

export const OpenTalkPlugin: Plugin = async ({ client, directory }) => {
  log("Plugin loaded")
  installResponseSuppression()

  const { getTalkConfig, getVoiceConfig } = createTalkConfigResolver({
    directory,
    async resolveProvider(providerId) {
      try {
        const providers = await client.config.providers()
        const data = (providers as Record<string, unknown>).data ?? providers
        const list = (data as Record<string, unknown>).providers ?? data ?? []
        if (!Array.isArray(list)) return null
        const provider = list.find(
          (p: Record<string, unknown>) => p.id === providerId,
        )
        if (!provider) return null
        return {
          baseUrl:
            (provider.options as Record<string, string> | undefined)?.baseURL,
          apiKey: provider.key as string | undefined,
        }
      } catch (err) {
        console.warn("[OpenTalk] provider resolution failed:", err)
        return null
      }
    },
  })

  let talkEnabled = true
  const sessionAgent = new Map<string, string>()

  return {
    dispose: async () => {
      uninstallResponseSuppression()
    },

    "chat.message": async (input, output) => {
      if (input.agent) {
        sessionAgent.set(input.sessionID, input.agent)
      }

      const textParts = output.parts.filter(
        (p: Record<string, unknown>) =>
          p.type === "text" && !p.synthetic && !p.ignored,
      )
      if (textParts.length === 0) return

      const fullText = textParts
        .map((p: Record<string, unknown>) => (p.text as string) ?? "")
        .join(" ")
        .trim()

      if (fullText === "/talk on") {
        talkEnabled = true
        await injectMessage(client, input.sessionID, "🔊 Spoken summaries enabled")
        activateSuppression()
        throw new OpenTalkAbortError()
      }

      if (fullText === "/talk off") {
        talkEnabled = false
        await injectMessage(client, input.sessionID, "🔊 Spoken summaries disabled")
        activateSuppression()
        throw new OpenTalkAbortError()
      }

      if (fullText.startsWith("/say ")) {
        const text = fullText.slice("/say ".length).trim()
        if (text) {
          const voiceCfg = await getVoiceConfig()
          doSpeak(text, voiceCfg)
          await injectMessage(client, input.sessionID, `🔊 ${text}`)
        }
        activateSuppression()
        throw new OpenTalkAbortError()
      }
    },

    event: async ({ event }) => {
      if (!talkEnabled) return
      if (event.type !== "session.idle") return

      const { sessionID } = event.properties
      const agentName = sessionAgent.get(sessionID)
      if (!agentName || agentName === AGENT_NAME) return

      const config = await getTalkConfig(agentName)
      if (!config) return

      // Extract the assistant's response text based on configured source
      const responseText = await getResponseText(client, sessionID, config.source)
      if (!responseText || responseText.startsWith("🔊 ")) return

      // local-summarize: use the local server's LLM → TTS pipeline
      if (config.voice.provider === "local-summarize") {
        const systemPrompt = readTalkMdBody(directory)
        const baseUrl = config.voice.baseUrl || "http://127.0.0.1:8765"
        const summary = await summarizeViaLocalServer(
          responseText,
          config.instruction,
          systemPrompt,
          config.voice.voice ?? "af_bella",
          config.voice.speed ?? 1.0,
          baseUrl,
        )
        if (summary) {
          await injectMessage(client, sessionID, `🔊 ${summary}`)
        }
        return
      }

      // summarize: false — speak the raw response directly
      if (!config.summarize) {
        const truncated = responseText.length > 1000
          ? responseText.slice(0, 997) + "..."
          : responseText
        await doSpeak(truncated, config.voice)
        await injectMessage(client, sessionID, `🔊 ${truncated}`)
        return
      }

      // process: true — summarize via subagent
      const instruction = config.instruction
      let ttsSessionId: string | undefined

      try {
        const ttsSession = await client.session.create({ body: { title: "OpenTalk" } })
        const result = (ttsSession as { data?: { id: string } }).data ?? ttsSession
        if (!result || typeof (result as { id?: string }).id !== "string") {
          console.error("[OpenTalk] failed to create TTS session")
          return
        }
        ttsSessionId = (result as { id: string }).id

        const ttsResult = await client.session.prompt({
          path: { id: ttsSessionId },
          body: {
            agent: AGENT_NAME,
            parts: [{
              type: "text",
              text: `Instruction: ${instruction}\n\nAssistant response to summarize:\n${responseText}`,
            }],
          },
        })

        const data = (ttsResult as Record<string, unknown>).data ?? ttsResult
        const parts = (data as Record<string, unknown>).parts ?? []
        const spoken = (parts as Array<{ type: string; text?: string }>)
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join(" ").trim()

        if (spoken) {
          await doSpeak(spoken, config.voice)
          await injectMessage(client, sessionID, `🔊 ${spoken}`)
        }
      } catch (err) {
        console.error("[OpenTalk] summarization failed:", err)
      } finally {
        if (ttsSessionId) {
          try { await client.session.delete({ path: { id: ttsSessionId } }) } catch {}
        }
      }
    },
  }
}

/** Reads the body of talk.md (everything after the YAML frontmatter). */
function readTalkMdBody(directory: string): string {
  const paths = [
    join(directory, ".opencode", "agents", "talk.md"),
    join(directory, "agents", "talk.md"),
    join(homedir(), ".config", "opencode", "agents", "talk.md"),
  ]
  for (const p of paths) {
    try {
      if (!existsSync(p)) continue
      const content = readFileSync(p, "utf-8")
      const m = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/)
      if (m?.[1]?.trim()) return m[1].trim()
    } catch { /* skip unreadable files */ }
  }
  console.warn("[OpenTalk] talk.md body not found — local-summarize won't work")
  return ""
}

/**
 * Sends a summarization request to the local server, which runs the LLM
 * and pipes the result to kokoro TTS. Returns the spoken summary text.
 */
async function summarizeViaLocalServer(
  responseText: string,
  instruction: string,
  systemPrompt: string,
  voice: string,
  speed: number,
  baseUrl: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}/summarize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Instruction: ${instruction}\n\nAssistant response to summarize:\n${responseText}` },
        ],
        stream: true,
        speak: true,
        voice,
        speed,
        temperature: 0.1,
        max_tokens: 80,
      }),
    })

    if (!res.ok) {
      console.error(`[OpenTalk] local server returned ${res.status}: ${await res.text().catch(() => "")}`)
      return null
    }

    if (!res.body) {
      console.error("[OpenTalk] local server: no response body")
      return null
    }

    // Parse SSE stream
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let fullText = ""
    let leftover = ""

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value, { stream: true })
      leftover += chunk
      const lines = leftover.split("\n")
      leftover = lines.pop() ?? ""

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue
        const data = line.slice(6)
        if (data === "[DONE]") continue
        try {
          const parsed = JSON.parse(data)
          const content = parsed?.choices?.[0]?.delta?.content
          if (content) fullText += content
        } catch { /* skip malformed lines */ }
      }
    }

    return fullText.trim() || null
  } catch (err) {
    console.error("[OpenTalk] local server request failed:", err)
    return null
  }
}

/** Extracts the last assistant's text content from a session, scoped by source. */
async function getResponseText(
  client: any,
  sessionID: string,
  source: "last-message" | "last-paragraph" | "last-sentence" = "last-message",
): Promise<string | null> {
  try {
    const msgs = await client.session.messages({ path: { id: sessionID } })
    const data = (msgs as Record<string, unknown>).data ?? msgs
    if (!Array.isArray(data)) return null

    const assistantMessages = (data as Array<Record<string, unknown>>).filter(
      (m) => m.info && (m.info as Record<string, unknown>).role === "assistant",
    )
    if (assistantMessages.length === 0) return null

    const lastMsg = assistantMessages[assistantMessages.length - 1]
    const parts = (lastMsg.parts ?? []) as Array<{ type: string; text?: string }>
    const fullText = parts
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("\n")
      .trim()

    if (!fullText) return null

    switch (source) {
      case "last-sentence": {
        const sentences = fullText.split(/(?<=[.!?])\s+/)
        const last = sentences.filter(s => s.trim()).pop()
        return last?.trim() || null
      }
      case "last-paragraph": {
        const paragraphs = fullText.split(/\n\s*\n/)
        const last = paragraphs.filter(p => p.trim()).pop()
        return last?.trim() || null
      }
      default:
        return fullText
    }
  } catch (err) {
    console.error("[OpenTalk] getResponseText failed:", err)
    return null
  }
}
