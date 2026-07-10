/**
 * TTS engine registry and dispatcher.
 * Maps provider names to engine instances and provides a single `doSpeak()` entry point.
 */
import type { TtsEngine } from "./types"
import type { VoiceConfig } from "../types"
import { sayEngine } from "./say"
import { openrouterEngine } from "./openrouter"
import { kokoroEngine } from "./kokoro"

// ── Registry ──

const engines = new Map<string, TtsEngine>()

let _initialized = false

/** Tracks the current speech — aborted before each new `doSpeak` call. */
let _currentAbort: AbortController | null = null

function ensureRegistered(): void {
  if (_initialized) return
  engines.set(sayEngine.name, sayEngine)
  engines.set(openrouterEngine.name, openrouterEngine)
  engines.set(kokoroEngine.name, kokoroEngine)
  _initialized = true
}

// ── Public API ──

/** Register a custom TTS engine. Call before first `doSpeak()`. */
export function registerEngine(engine: TtsEngine): void {
  engines.set(engine.name, engine)
}

/**
 * Maps a voice config provider to the internally registered engine name.
 * - "say"       → sayEngine
 * - "local"     → kokoroEngine (local server on localhost:8765)
 * - other       → openrouterEngine (cloud provider with API credentials)
 */
function engineNameForProvider(provider: string): string {
  if (provider === "say") return "say"
  if (provider === "local") return "kokoro"
  return "openrouter"
}

/** Produce spoken audio for the given text using the configured voice provider. */
export async function doSpeak(
  text: string,
  config: VoiceConfig,
): Promise<void> {
  if (!text.trim()) return

  ensureRegistered()

  const engineName = engineNameForProvider(config.provider)
  const engine = engines.get(engineName) ?? engines.get("say")

  if (!engine) {
    console.error(`[OpenTalk] no TTS engine found for provider "${config.provider}"`)
    return
  }

  try {
    // Abort any currently-running speech before starting new
    if (_currentAbort) {
      _currentAbort.abort()
    }
    _currentAbort = new AbortController()

    await engine.speak(text, config, _currentAbort.signal)
  } catch (err) {
    console.error("[OpenTalk] doSpeak failed:", err)
  } finally {
    _currentAbort = null
  }
}
