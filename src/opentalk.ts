/**
 * OpenTalk — OpenCode plugin that speaks short summaries when agents finish.
 *
 * On session.idle, reads the agent's resolved `speak:` config (base defaults
 * from speak.md deep-merged with per-agent overrides):
 * - process: true  → spawns the speak subagent to summarize, then speaks
 * - process: false → speaks the raw response text directly
 * - enabled: false → no speaking
 */
import type { Plugin } from "@opencode-ai/plugin"
import { log } from "./logger"
import {
  installResponseSuppression,
  uninstallResponseSuppression,
  activateSuppression,
} from "./response-suppression"
import { createSpeakConfigResolver } from "./config"
import { injectMessage } from "./session"
import { doSpeak } from "./tts-engines/registry"
import type { SpeakConfig } from "./types"

const AGENT_NAME = "speak"

class OpenTalkAbortError extends Error {
  constructor() {
    super("OPENTALK")
    this.name = "OpenTalkAbortError"
  }
}

export const OpenTalkPlugin: Plugin = async ({ client, directory }) => {
  log("Plugin loaded")
  installResponseSuppression()

  const { getSpeakConfig, getVoiceConfig } = createSpeakConfigResolver({
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

  let speakEnabled = true
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

      if (fullText === "/set-speak on") {
        speakEnabled = true
        await injectMessage(client, input.sessionID, "🔊 Spoken summaries enabled")
        activateSuppression()
        throw new OpenTalkAbortError()
      }

      if (fullText === "/set-speak off") {
        speakEnabled = false
        await injectMessage(client, input.sessionID, "🔊 Spoken summaries disabled")
        activateSuppression()
        throw new OpenTalkAbortError()
      }

      if (fullText.startsWith("/speak ")) {
        const text = fullText.slice("/speak ".length).trim()
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
      if (!speakEnabled) return
      if (event.type !== "session.idle") return

      const { sessionID } = event.properties
      const agentName = sessionAgent.get(sessionID)
      if (!agentName || agentName === AGENT_NAME) return

      const config = await getSpeakConfig(agentName)
      if (!config) return

      // Extract the assistant's response text
      const responseText = await getResponseText(client, sessionID)
      if (!responseText || responseText.startsWith("🔊 ")) return

      // process: false — speak the raw response directly
      if (!config.process) {
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

/** Extracts the last assistant's text content from a session. */
async function getResponseText(
  client: any,
  sessionID: string,
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
    const text = parts
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("\n")
      .trim()

    return text || null
  } catch (err) {
    console.error("[OpenTalk] getResponseText failed:", err)
    return null
  }
}
