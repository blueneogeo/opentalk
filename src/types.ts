/** TTS engine configuration */
export interface TtsConfig {
  engine: "say" | "openrouter" | "kokoro"
  model: string
  voice: string
  speed: number
  responseFormat: "mp3" | "pcm"
  apiKey?: string
  baseUrl?: string
}

/** How spoken output is produced for a given agent */
export type SpeakMode = "extract" | "subagent"

/** How the speak agent should produce spoken output for a given agent */
export type SpeakDirective =
  | { type: "instruction"; value: string; mode: SpeakMode }
  | { type: "full"; mode: SpeakMode }
