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

/** Resolved talk configuration for a specific agent (base defaults + agent overrides merged) */
export interface TalkConfig {
  enabled: boolean
  process: boolean
  instruction: string
  model: string
  voice: VoiceConfig
}
