/**
 * OpenRouter TTS engine.
 * Calls an OpenAI-compatible /v1/audio/speech endpoint, downloads
 * the audio as MP3, and plays it via `afplay`.
 */
import { join } from "node:path"
import { tmpdir } from "node:os"
import { writeFileSync, unlinkSync } from "node:fs"
import type { TtsEngine } from "./types"
import type { VoiceConfig } from "../types"

async function playAndCleanup(filePath: string, signal?: AbortSignal): Promise<void> {
  try {
    const proc = Bun.spawn(["afplay", filePath])

    const onAbort = () => proc.kill()
    signal?.addEventListener("abort", onAbort, { once: true })

    const exitCode = await proc.exited

    signal?.removeEventListener("abort", onAbort)

    if (exitCode !== 0) {
      console.error(
        `[OpenTalk] afplay exited with code ${exitCode}`,
      )
    }
  } catch (err) {
    console.error("[OpenTalk] afplay failed:", err)
  } finally {
    try {
      unlinkSync(filePath)
    } catch {
      // File may already be gone — not a problem
    }
  }
}

export const openrouterEngine: TtsEngine = {
  name: "openrouter",

  async speak(text: string, config: VoiceConfig, signal?: AbortSignal): Promise<void> {
    const { apiKey, baseUrl, model, voice, speed, responseFormat } = config
    const url = `${baseUrl ?? "https://openrouter.ai/api/v1"}/audio/speech`

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
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

    if (!res.ok) {
      throw new Error(`TTS API returned ${res.status}: ${await res.text().catch(() => "")}`)
    }

    const buf = Buffer.from(await res.arrayBuffer())
    const tmp = join(tmpdir(), `opentalk-${Date.now()}.mp3`)
    writeFileSync(tmp, buf)

    // Await playback so the caller can sequence with interruption
    await playAndCleanup(tmp, signal)
  },
}
