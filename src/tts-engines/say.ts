/**
 * macOS `say` TTS engine.
 * Uses the built-in `say` command — no network, no API key required.
 */
import type { TtsEngine } from "./types"
import type { VoiceConfig } from "../types"

export const sayEngine: TtsEngine = {
  name: "say",

  async speak(text: string, config: VoiceConfig): Promise<void> {
    const voice = config.voice || "Samantha"
    const rate = Math.round((config.speed ?? 1.0) * 200).toString()
    const args = ["-v", voice, "-r", rate, text]

    try {
      const proc = Bun.spawn(["say", ...args], {
        stdout: "ignore",
        stderr: "ignore",
      })
      const exitCode = await proc.exited
      if (exitCode !== 0) {
        console.error(
          `[OpenTalk] say exited with code ${exitCode} (voice: ${voice}, rate: ${rate})`,
        )
      }
    } catch (err) {
      console.error("[OpenTalk] say command failed:", err)
    }
  },
}
