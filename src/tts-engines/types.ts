/**
 * @fileoverview TTS engine interface and types.
 */
import type { VoiceConfig } from "../types"

/** A TTS engine that can speak text using a specific backend. */
export interface TtsEngine {
  readonly name: string
  /**
   * Produces audio output for the given text.
   * Receives an optional AbortSignal — engines should kill playback when it fires.
   */
  speak(text: string, config: VoiceConfig, signal?: AbortSignal): Promise<void>
}
