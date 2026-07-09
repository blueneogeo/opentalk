/**
 * Session utilities — extracting assistant response text and
 * injecting synthetic messages back into the conversation.
 */

/**
 * Extracts the text content of the last assistant message in a session.
 * Returns null if no text content is found.
 */
export async function extractResponseText(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  sessionID: string,
): Promise<string | null> {
  try {
    const msgs = await client.session.messages({ path: { id: sessionID } })
    // The SDK type may wrap results; access .data if present
    const data = (msgs as Record<string, unknown>).data ?? msgs
    if (!Array.isArray(data)) return null

    const assistantMessages = (data as Array<Record<string, unknown>>).filter(
      (m) => m.info && (m.info as Record<string, unknown>).role === "assistant",
    )
    if (assistantMessages.length === 0) return null

    const lastMsg = assistantMessages[assistantMessages.length - 1]
    const parts = (lastMsg.parts ?? []) as Array<{
      type: string
      text?: string
    }>
    const text = parts
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("\n")
      .trim()

    return text || null
  } catch (err) {
    console.error("[OpenTalk] extractResponseText failed:", err)
    return null
  }
}

/**
 * Injects a synthetic text message into a session.
 * Uses `noReply: true` to avoid triggering the assistant.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function injectMessage(
  client: any,
  sessionID: string,
  text: string,
): Promise<void> {
  try {
    await client.session.prompt({
      path: { id: sessionID },
      body: {
        noReply: true,
        parts: [{ type: "text" as const, text }],
      },
    })
  } catch (err) {
    console.error("[OpenTalk] injectMessage failed:", err)
  }
}
