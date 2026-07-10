/**
 * @fileoverview TTS engine interface and types.
 */
import type { VoiceConfig } from "../types"

/** A TTS engine that can speak text using a specific backend. */
export interface TtsEngine {
  readonly name: string
  /** Produces audio output for the given text. Resolves when playback begins (may be fire-and-forget). */
  speak(text: string, config: VoiceConfig): Promise<void>
}
