/**
 * Speak configuration loading, parsing, merging, and resolution.
 *
 * Reads the `speak:` block from speak.md (base defaults) and from each
 * agent's .md file (overrides). Deep-merges them into a resolved
 * SpeakConfig per agent, with voice provider credential resolution.
 */
import { join } from "node:path"
import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import type { SpeakConfig, VoiceConfig } from "./types"

// ── Constants ──

const AGENT_NAME_SPEAK = "speak"

const HARD_DEFAULTS: SpeakConfig = {
  enabled: false,
  process: true,
  instruction: "Summarize in one conversational sentence, under 25 words",
  model: "opencode-go/deepseek-v4-flash",
  voice: {
    provider: "say",
  },
}

const CONFIG_LOAD_TIMEOUT_MS = 10_000

// ── Parser types ──

interface ParsedSpeakBlock {
  enabled?: string
  process?: string
  instruction?: string
  model?: string
  voice?: Record<string, string>
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

// ── Env variable interpolation ──

/** Resolves `${VAR}` patterns against process.env. */
export function resolveEnv(value: string): string {
  const m = value.match(/^\$\{(.+)\}$/)
  return m ? (process.env[m[1]] ?? "") : value
}

// ── Provider credential resolution ──

export interface ProviderInfo {
  baseUrl?: string
  apiKey?: string
}

export type ProviderResolver = (
  providerId: string,
) => Promise<ProviderInfo | null>

// ── YAML frontmatter parser (nested `speak:` block) ──

/**
 * Parses the `speak:` block from YAML frontmatter, including
 * the nested `voice:` sub-block. Returns null if no `speak:`
 * block is found or the block is empty.
 */
export function parseSpeakBlock(frontmatter: string): ParsedSpeakBlock | null {
  const lines = frontmatter.split("\n")

  // Find the `speak:` line at indent 0
  let i = 0
  while (i < lines.length) {
    if (lines[i].trimStart().startsWith("speak:")) break
    i++
  }
  if (i >= lines.length) return null
  i++ // skip past `speak:` line

  // Determine speak-level indentation from the first content line
  let speakIndent = -1
  for (let j = i; j < lines.length; j++) {
    const t = lines[j].trim()
    if (t !== "" && !t.startsWith("#")) {
      speakIndent = lines[j].length - t.length
      break
    }
  }
  if (speakIndent < 0) return null // empty block

  const result: ParsedSpeakBlock = {}

  for (; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    const indent = line.length - trimmed.length

    // Exit speak block on a non-indented, non-empty, non-comment line
    if (indent === 0 && trimmed !== "" && !trimmed.startsWith("#")) break

    // Skip empty lines and comments
    if (trimmed === "" || trimmed.startsWith("#")) continue

    // Only process lines at the speak-level indent
    if (indent !== speakIndent) continue

    const m = trimmed.match(/^([\w_]+):\s*(.*)$/)
    if (!m) continue

    if (m[1] === "voice") {
      // Enter voice sub-block — parse all lines at the next indentation level
      const voiceKeys: Record<string, string> = {}
      let voiceIndent = -1
      let voiceEnd = lines.length // default: runs to EOF

      for (let j = i + 1; j < lines.length; j++) {
        const vl = lines[j]
        const vt = vl.trim()
        const vi = vl.length - vt.length

        if (vi <= speakIndent) {
          voiceEnd = j
          break
        }
        if (vt === "" || vt.startsWith("#")) continue
        if (voiceIndent === -1) voiceIndent = vi
        if (vi !== voiceIndent) continue

        const vm = vt.match(/^([\w_]+):\s*(.*)$/)
        if (vm) voiceKeys[vm[1]] = vm[2]
      }

      if (Object.keys(voiceKeys).length > 0) {
        result.voice = voiceKeys
      }

      // Skip past the voice sub-block
      i = voiceEnd - 1
    } else {
      ;(result as Record<string, string>)[m[1]] = m[2]
    }
  }

  // Allow empty speak block with voice as valid
  if (Object.keys(result).length === 0 && !result.voice) return null
  return result
}

// ── Config conversion ──

function parseBool(raw: string, fallback: boolean): boolean {
  return raw === "true" ? true : raw === "false" ? false : fallback
}

function toSpeakConfig(raw: ParsedSpeakBlock): DeepPartial<SpeakConfig> {
  const cfg: DeepPartial<SpeakConfig> = {}

  if (raw.enabled !== undefined) cfg.enabled = parseBool(raw.enabled, false)
  if (raw.process !== undefined) cfg.process = parseBool(raw.process, true)
  if (raw.instruction !== undefined) cfg.instruction = raw.instruction
  if (raw.model !== undefined) cfg.model = raw.model

  if (raw.voice && Object.keys(raw.voice).length > 0) {
    const v: DeepPartial<VoiceConfig> = {}
    if (raw.voice.provider !== undefined) v.provider = raw.voice.provider
    if (raw.voice.model !== undefined) v.model = raw.voice.model
    if (raw.voice.voice !== undefined) v.voice = raw.voice.voice
    if (raw.voice.speed !== undefined) {
      const n = Number(raw.voice.speed)
      if (!Number.isNaN(n)) v.speed = n
    }
    if (raw.voice.response_format !== undefined) {
      v.responseFormat = raw.voice.response_format === "pcm" ? "pcm" : "mp3"
    }
    cfg.voice = v as VoiceConfig
  }

  return cfg
}

// ── Deep merge ──

function mergeSpeakConfig(
  base: SpeakConfig,
  override: DeepPartial<SpeakConfig>,
): SpeakConfig {
  return {
    enabled: override.enabled ?? base.enabled,
    process: override.process ?? base.process,
    instruction: override.instruction ?? base.instruction,
    model: override.model ?? base.model,
    voice: {
      provider: override.voice?.provider ?? base.voice.provider,
      model: override.voice?.model ?? base.voice.model,
      voice: override.voice?.voice ?? base.voice.voice,
      speed: override.voice?.speed ?? base.voice.speed,
      responseFormat:
        override.voice?.responseFormat ?? base.voice.responseFormat,
    },
  }
}

// ── File path resolution ──

function speakMdPaths(directory: string): string[] {
  return [
    join(directory, ".opencode", "agents", "speak.md"),
    join(directory, "agents", "speak.md"),
    join(homedir(), ".config", "opencode", "agents", "speak.md"),
  ]
}

function agentMdPaths(directory: string, agentName: string): string[] {
  return [
    join(directory, ".opencode", "agents", `${agentName}.md`),
    join(directory, "agents", `${agentName}.md`),
    join(homedir(), ".config", "opencode", "agents", `${agentName}.md`),
  ]
}

// ── Frontmatter extraction ──

function extractFrontmatter(content: string): string | null {
  const m = content.match(/^---\n([\s\S]*?)\n---/)
  return m ? m[1] : null
}

// ── Base config loading ──

function loadBaseConfig(directory: string): SpeakConfig {
  for (const p of speakMdPaths(directory)) {
    try {
      if (!existsSync(p)) continue
      const fm = extractFrontmatter(readFileSync(p, "utf-8"))
      if (!fm) continue
      const block = parseSpeakBlock(fm)
      if (!block) continue
      return mergeSpeakConfig(HARD_DEFAULTS, toSpeakConfig(block))
    } catch {
      // Config file errors → skip, try next path or fall through to defaults
    }
  }
  return HARD_DEFAULTS
}

// ── Agent config loading ──

function loadAgentConfig(
  directory: string,
  agentName: string,
): DeepPartial<SpeakConfig> | null {
  for (const p of agentMdPaths(directory, agentName)) {
    try {
      if (!existsSync(p)) continue
      const fm = extractFrontmatter(readFileSync(p, "utf-8"))
      if (!fm) continue
      const block = parseSpeakBlock(fm)
      if (!block) continue
      return toSpeakConfig(block)
    } catch {
      // skip
    }
  }
  return null
}

// ── Voice credential resolution ──

async function resolveVoiceCredentials(
  voice: VoiceConfig,
  resolveProvider: ProviderResolver,
): Promise<VoiceConfig> {
  const provider = voice.provider

  // say and local don't need credentials
  if (provider === "say" || provider === "local") return { ...voice }

  // Resolve via OpenCode provider registry
  try {
    const info = await resolveProvider(provider)
    if (info) {
      return {
        ...voice,
        baseUrl: voice.baseUrl ?? info.baseUrl,
        apiKey: voice.apiKey ?? info.apiKey,
      }
    }
  } catch {
    // provider resolution failed — fall through
  }

  // Fallback: direct env var
  if (!voice.apiKey) {
    voice.apiKey = process.env.OPENROUTER_API_KEY
  }

  // If still no credentials, fall back to "say"
  if (!voice.apiKey) {
    return { ...voice, provider: "say" }
  }

  return { ...voice }
}

// ── Public API ──

interface CreateResolverParams {
  directory: string
  resolveProvider: ProviderResolver
}

/**
 * Creates a speak config resolver for a given project directory.
 * Base config (from speak.md) is loaded once and cached.
 * Agent-level overrides are parsed and merged on each call,
 * with per-agent caching.
 */
export function createSpeakConfigResolver(params: CreateResolverParams) {
  let baseConfig: SpeakConfig | null = null
  let baseLoading = false
  let basePromise: Promise<SpeakConfig> | null = null
  const agentCache = new Map<string, SpeakConfig | null>()

  async function getBaseConfig(): Promise<SpeakConfig> {
    if (baseConfig) return baseConfig
    if (baseLoading && basePromise) {
      return await Promise.race([
        basePromise,
        new Promise<SpeakConfig>((_, reject) =>
          setTimeout(() => reject(new Error("base config load timed out")), CONFIG_LOAD_TIMEOUT_MS),
        ),
      ])
    }
    baseLoading = true
    basePromise = Promise.resolve(loadBaseConfig(params.directory))
    baseConfig = await basePromise
    return baseConfig
  }

  async function getSpeakConfig(agentName: string): Promise<SpeakConfig | null> {
    // Skip the speak agent itself to prevent recursion
    if (agentName === AGENT_NAME_SPEAK) return null

    const cached = agentCache.get(agentName)
    if (cached !== undefined) return cached

    try {
      const base = await getBaseConfig()
      const agentOverrides = loadAgentConfig(params.directory, agentName)

      // If agent has no `speak:` section at all, they don't opt in
      if (!agentOverrides) {
        agentCache.set(agentName, null)
        return null
      }

      // Merge base with agent overrides
      const merged = mergeSpeakConfig(base, agentOverrides)

      // Not enabled → no speaking
      if (!merged.enabled) {
        agentCache.set(agentName, null)
        return null
      }

      // Resolve voice provider credentials
      const resolvedVoice = await resolveVoiceCredentials(
        merged.voice,
        params.resolveProvider,
      )

      const resolved: SpeakConfig = { ...merged, voice: resolvedVoice }
      agentCache.set(agentName, resolved)
      return resolved
    } catch (err) {
      console.warn("[OpenTalk] config resolution failed for", agentName, err)
      agentCache.set(agentName, null)
      return null
    }
  }

  /**
   * Returns the base voice config (from speak.md defaults) with
   * credentials resolved. Used for inline `/speak` commands.
   */
  async function getVoiceConfig(): Promise<VoiceConfig> {
    const base = await getBaseConfig()
    return resolveVoiceCredentials(base.voice, params.resolveProvider)
  }

  return { getSpeakConfig, getVoiceConfig }
}
