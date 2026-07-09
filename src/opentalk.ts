/**
 * OpenTalk — OpenCode plugin that speaks short summaries when agents finish.
 *
 * Two modes (configured per agent via `speak_mode:` frontmatter):
 * - extract (default): agent produces <speak> tags, plugin extracts them
 * - subagent: plugin spawns the speak subagent to summarize the response
 */
import type { Plugin } from "@opencode-ai/plugin"
import { log } from "./logger"
import {
  installResponseSuppression,
  uninstallResponseSuppression,
  activateSuppression,
} from "./response-suppression"
import { createConfigLoader, getSpeakSystem } from "./config"
import { createDirectiveResolver } from "./directive"
import { extractResponseText, injectMessage } from "./session"
import { doSpeak } from "./tts-engines/registry"
import type { SpeakDirective } from "./types"

const AGENT_NAME = "speak"
const SPEAK_TAG_RE = /spoken:\s*(.+?)(?:\n|$)/

class OpenTalkAbortError extends Error {
  constructor() {
    super("OPENTALK")
    this.name = "OpenTalkAbortError"
  }
}

export const OpenTalkPlugin: Plugin = async ({ client, directory }) => {
  log("Plugin loaded")
  installResponseSuppression()

  const getTtsConfig = createConfigLoader({
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

  const { getSpeakDirective } = createDirectiveResolver(directory)

  let speakEnabled = true
  const sessionAgent = new Map<string, string>()
  const agentsSeeded = new Set<string>()

  function instructionFor(directive: SpeakDirective): string {
    return directive.type === "full"
      ? "summarize your full response in one sentence"
      : directive.value
  }

  function buildSystemSuffix(directive: SpeakDirective): string | null {
    if (directive.mode !== "extract") return null
    const system = getSpeakSystem(directory)
    return "\n\n" + system.replace("${SPEAK_INSTRUCTION}", instructionFor(directive))
  }

  function buildReminderSuffix(directive: SpeakDirective): string | null {
    if (directive.mode !== "extract") return null
    return "\n\n<system>In your thinking include: spoken: " + instructionFor(directive) + "</system>"
  }

  async function speakExtracted(responseText: string, sid: string): Promise<void> {
    const match = responseText.match(SPEAK_TAG_RE)
    if (!match || !match[1].trim()) return
    const cfg = await getTtsConfig()
    await doSpeak(match[1].trim(), cfg)
    await injectMessage(client, sid, `🔊 ${match[1].trim()}`)
  }

  return {
    dispose: async () => {
      uninstallResponseSuppression()
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      const messages = (output as Record<string, unknown>).messages as
        | Array<{ info?: { role?: string; agent?: string }; parts?: Array<Record<string, unknown>> }>
        | undefined
      if (!messages || messages.length === 0) return

      const lastMessage = messages[messages.length - 1]
      if (lastMessage?.info?.role !== "user" || !lastMessage.info.agent) return

      const directive = getSpeakDirective(lastMessage.info.agent)
      if (!directive) return

      const isFirst = !agentsSeeded.has(lastMessage.info.agent)
      agentsSeeded.add(lastMessage.info.agent)
      const suffix = isFirst
        ? buildSystemSuffix(directive)
        : buildReminderSuffix(directive)
      if (!suffix) return

      if (!lastMessage.parts) lastMessage.parts = []
      lastMessage.parts.push({ type: "text", text: suffix })
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

      if (fullText === "/toggle-speak") {
        speakEnabled = !speakEnabled
        await injectMessage(client, input.sessionID,
          `🔊 Spoken summaries ${speakEnabled ? "enabled" : "disabled"}`)
        activateSuppression()
        throw new OpenTalkAbortError()
      }

      if (fullText.startsWith("/speak ")) {
        const text = fullText.slice("/speak ".length).trim()
        if (text) {
          const cfg = await getTtsConfig()
          doSpeak(text, cfg)
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

      const directive = getSpeakDirective(agentName)
      if (!directive) return

      const responseText = await extractResponseText(client, sessionID)
      if (!responseText) return
      if (responseText.startsWith("🔊 ")) return

      if (directive.mode === "extract") {
        await speakExtracted(responseText, sessionID)
        return
      }

      if (directive.type === "full") {
        const truncated = responseText.length > 1000
          ? responseText.slice(0, 997) + "..."
          : responseText
        const cfg = await getTtsConfig()
        await doSpeak(truncated, cfg)
        await injectMessage(client, sessionID, `🔊 ${truncated}`)
        return
      }

      const instruction = directive.value
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
          const cfg = await getTtsConfig()
          await doSpeak(spoken, cfg)
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
