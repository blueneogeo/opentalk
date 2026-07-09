/**
 * TTS engine registry and dispatcher.
 * Maps engine names to engine instances and provides a single `doSpeak()` entry point.
 */
import type { TtsEngine } from "./types"
import type { TtsConfig } from "../types"
import { sayEngine } from "./say"
import { openrouterEngine } from "./openrouter"
import { kokoroEngine } from "./kokoro"

// ── Registry ──

const engines = new Map<string, TtsEngine>()

let _initialized = false

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

/** Produce spoken audio for the given text using the configured engine. */
export async function doSpeak(
  text: string,
  config: TtsConfig,
): Promise<void> {
  if (!text.trim()) return

  ensureRegistered()

  const engine = engines.get(config.engine) ?? engines.get("say")

  if (!engine) {
    console.error(`[OpenTalk] no TTS engine found for "${config.engine}"`)
    return
  }

  try {
    await engine.speak(text, config)
  } catch (err) {
    console.error("[OpenTalk] doSpeak failed:", err)
  }
}
