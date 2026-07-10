/** Voice synthesis configuration */
export interface VoiceConfig {
  provider: string
  model?: string
  voice?: string
  speed?: number
  responseFormat?: "mp3" | "pcm"
  apiKey?: string
  baseUrl?: string
}

/** Resolved speak configuration for a specific agent (base defaults + agent overrides merged) */
export interface SpeakConfig {
  enabled: boolean
  process: boolean
  instruction: string
  model: string
  voice: VoiceConfig
}
