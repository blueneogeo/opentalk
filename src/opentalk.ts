import type { Plugin } from "@opencode-ai/plugin"
import { join } from "node:path"
import { homedir } from "node:os"
import { readFileSync, existsSync } from "node:fs"

export const OpenTalkPlugin: Plugin = async ({ client, directory }) => {

  const AGENT_NAME = "speak"

  // ── Session → agent tracking ──
  // session.idle only carries sessionID, not agent name.
  // We track which agent handles each session via chat.message.
  const sessionAgent = new Map<string, string>()

  // ── speak instruction cache (agent name → instruction or null) ──
  const speakCache = new Map<string, string | null>()

  /**
   * Read the `speak` frontmatter property from an agent markdown file.
   * Search order: project .opencode/agents → project agents → global agents.
   * Results are cached per agent name.
   */
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
      } catch {
        // file doesn't exist or can't be read — try next path
      }
    }

    speakCache.set(agentName, null)
    return null
  }

  /**
   * Extract the text content from the last assistant message in a session.
   * Only returns text parts (skips tool calls, step markers, etc.).
   */
  const extractResponseText = async (sessionID: string): Promise<string | null> => {
    try {
      const msgs = await client.session.messages({ path: { id: sessionID } })

      const data = (msgs as any).data ?? msgs
      if (!Array.isArray(data)) return null

      const assistantMessages = data.filter(
        (m: any) => m.info?.role === "assistant"
      )
      if (assistantMessages.length === 0) return null

      const lastMsg = assistantMessages[assistantMessages.length - 1]
      const text = (lastMsg.parts ?? [])
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join("\n")
        .trim()

      return text || null
    } catch {
      return null
    }
  }

  /**
   * Speak text aloud using macOS `say` command (fire-and-forget).
   * Uses Samantha voice at slightly faster rate for natural-sounding speech.
   */
  const speak = (text: string): void => {
    Bun.spawn(["say", "-v", "Samantha", "-r", "200", text])
  }

  return {
    /**
     * Track which agent is assigned to each session.
     * The agent field is set when a user message is created.
     */
    "chat.message": async (input) => {
      if (input.agent) {
        sessionAgent.set(input.sessionID, input.agent)
      }
    },

    /**
     * When a session goes idle, check if the agent has a `speak` instruction.
     * If so, send the instruction + full response to the speak agent, then
     * speak the resulting summary aloud.
     */
    event: async ({ event }) => {
      if (event.type !== "session.idle") return

      const { sessionID } = event.properties

      // Find which agent was active for this session
      const agentName = sessionAgent.get(sessionID)
      if (!agentName) return

      // Don't speak for the speak agent itself (avoid loops)
      if (agentName === AGENT_NAME) return

      // Check if this agent has a `speak` instruction
      const instruction = getSpeakInstruction(agentName)
      if (!instruction) return

      // Get the assistant's full response text
      const responseText = await extractResponseText(sessionID)
      if (!responseText) return

      try {
        // Create a dedicated session for the speak agent
        const ttsSession = await client.session.create({
          body: { title: "OpenTalk" },
        })

        const ttsResult = await client.session.prompt({
          path: { id: ttsSession.data.id },
          body: {
            agent: AGENT_NAME,
            parts: [
              {
                type: "text",
                text: [
                  `Instruction: ${instruction}`,
                  "",
                  `Assistant response to summarize:`,
                  responseText,
                ].join("\n"),
              },
            ],
          },
        })

        // Extract spoken text from speak agent's response
        const data = (ttsResult as any).data ?? ttsResult
        const parts = data.parts ?? []
        const spoken = parts
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text)
          .join(" ")
          .trim()

        if (spoken) {
          speak(spoken)

          // Also inject the summary as a visible message in the conversation
          try {
            await client.session.prompt({
              path: { id: sessionID },
              body: {
                noReply: true,
                parts: [{ type: "text", text: `🔊 ${spoken}` }],
              },
            })
          } catch {
            // best effort — don't disrupt if injection fails
          }
        }

        // Clean up the TTS session so it doesn't linger
        try { await client.session.delete({ path: { id: ttsSession.data.id } }) } catch {}
      } catch {
        // If anything fails (TTS agent missing, model error, etc.),
        // fail silently — don't disrupt the main conversation.
      }
    },
  }
}
