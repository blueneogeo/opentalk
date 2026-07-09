/**
 * OpenTalk — OpenCode plugin that speaks short summaries when agents finish.
 *
 * Hooks into `chat.message` to track which agent handles each session,
 * and `session.idle` to generate + speak a conversational summary.
 */
import type { Plugin } from "@opencode-ai/plugin"
import { log } from "./logger"
import {
  installResponseSuppression,
  uninstallResponseSuppression,
  activateSuppression,
} from "./response-suppression"
import { createConfigLoader } from "./config"
import { createDirectiveResolver } from "./directive"
import { extractResponseText, injectMessage } from "./session"
import { doSpeak } from "./tts-engines/registry"

// ── Constants ──

const AGENT_NAME = "speak"

// ── Sentinel error ──

/**
 * Thrown to abort a chat.message hook after processing a
 * /toggle-speak or /speak command. The framework catches this.
 */
class OpenTalkAbortError extends Error {
  constructor() {
    super("OPENTALK")
    this.name = "OpenTalkAbortError"
  }
}

// ── Plugin ──

export const OpenTalkPlugin: Plugin = async ({ client, directory }) => {
  log("Plugin loaded")

  // ── Response suppression (intentional workaround) ──
  installResponseSuppression()

  // ── Config & caches ──
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
            (provider.options as Record<string, string> | undefined)
              ?.baseURL,
          apiKey: provider.key as string | undefined,
        }
      } catch (err) {
        console.warn("[OpenTalk] provider resolution failed:", err)
        return null
      }
    },
  })

  const { getSpeakDirective } = createDirectiveResolver(directory)

  // ── State ──
  let speakEnabled = true
  const sessionAgent = new Map<string, string>()

  // ── Hooks ──

  return {
    dispose: async () => {
      uninstallResponseSuppression()
    },

    "chat.message": async (input, output) => {
      // Track which agent handles this session
      if (input.agent) {
        sessionAgent.set(input.sessionID, input.agent)
      }

      // Check for built-in voice commands
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
        await injectMessage(
          client,
          input.sessionID,
          `🔊 Spoken summaries ${speakEnabled ? "enabled" : "disabled"}`,
        )
        log("/toggle-speak — activating suppression")
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
        log("/speak", text, "— activating suppression")
        activateSuppression()
        throw new OpenTalkAbortError()
      }
    },

    event: async ({ event }) => {
      if (!speakEnabled) return
      if (event.type !== "session.idle") return

      const { sessionID } = event.properties
      const agentName = sessionAgent.get(sessionID)

      // Guard: skip if no agent tracked or it's the speak agent itself
      if (!agentName || agentName === AGENT_NAME) return

      const directive = getSpeakDirective(agentName)
      if (!directive) return

      const responseText = await extractResponseText(client, sessionID)
      if (!responseText) return

      // Skip messages we injected ourselves
      if (responseText.startsWith("🔊 ")) return

      if (directive.type === "full") {
        const truncated =
          responseText.length > 1000
            ? responseText.slice(0, 997) + "..."
            : responseText

        const cfg = await getTtsConfig()
        await doSpeak(truncated, cfg)
        await injectMessage(client, sessionID, `🔊 ${truncated}`)
        return
      }

      // ── Summarization path ──
      const instruction = directive.value
      let ttsSessionId: string | undefined

      try {
        const ttsSession = await client.session.create({
          body: { title: "OpenTalk" },
        })
        const result = (
          ttsSession as { data?: { id: string } }
        ).data ?? ttsSession
        if (!result || typeof (result as { id?: string }).id !== "string") {
          console.error("[OpenTalk] failed to create TTS session")
          return
        }
        ttsSessionId = (result as { id: string }).id

        const ttsResult = await client.session.prompt({
          path: { id: ttsSessionId },
          body: {
            agent: AGENT_NAME,
            parts: [
              {
                type: "text",
                text: `Instruction: ${instruction}\n\nAssistant response to summarize:\n${responseText}`,
              },
            ],
          },
        })

        const data =
          (ttsResult as Record<string, unknown>).data ?? ttsResult
        const parts = (data as Record<string, unknown>).parts ?? []
        const spoken = (parts as Array<{ type: string; text?: string }>)
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join(" ")
          .trim()

        if (spoken) {
          const cfg = await getTtsConfig()
          await doSpeak(spoken, cfg)
          await injectMessage(client, sessionID, `🔊 ${spoken}`)
        }
      } catch (err) {
        console.error("[OpenTalk] summarization failed:", err)
      } finally {
        // Always clean up the TTS session, even on error
        if (ttsSessionId) {
          try {
            await client.session.delete({ path: { id: ttsSessionId } })
          } catch {
            // Best-effort cleanup
          }
        }
      }
    },
  }
}
