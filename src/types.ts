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

/** How the speak agent should produce spoken output for a given agent */
export type SpeakDirective =
  | { type: "instruction"; value: string }
  | { type: "full" }
