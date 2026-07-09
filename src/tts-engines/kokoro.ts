/**
 * Kokoro TTS engine.
 * Sends text to a local Python HTTP server running kokoro-mlx.
 * The server handles playback internally; this module just POSTs the text.
 */
import type { TtsEngine } from "./types"
import type { TtsConfig } from "../types"

const KOKORO_URL = "http://127.0.0.1:8765"

export const kokoroEngine: TtsEngine = {
  name: "kokoro",

  async speak(text: string, config: TtsConfig): Promise<void> {
    const voice = config.voice || "af_bella"

    const res = await fetch(`${KOKORO_URL}/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice }),
    })

    if (!res.ok) {
      throw new Error(
        `Kokoro server returned ${res.status}: ${await res.text().catch(() => "")}`,
      )
    }
  },
}
