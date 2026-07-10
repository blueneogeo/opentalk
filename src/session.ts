/**
 * Session utilities — injecting synthetic messages into the conversation.
 */

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
