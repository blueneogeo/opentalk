/**
 * Talk configuration loading, parsing, merging, and resolution.
 *
 * Reads the `talk:` block from talk.md (base defaults) and from each
 * agent's .md file (overrides). Deep-merges them into a resolved
 * TalkConfig per agent, with voice provider credential resolution.
 */
import { join } from "node:path"
import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import type { TalkConfig, VoiceConfig } from "./types"

// ── Constants ──

const AGENT_NAME_TALK = "talk"

const HARD_DEFAULTS: TalkConfig = {
  enabled: false,
  summarize: true,
  source: "last-message",
  instruction: "Summarize in one conversational sentence, under 25 words",
  model: "opencode-go/deepseek-v4-flash",
  voice: {
    provider: "say",
  },
}

const CONFIG_LOAD_TIMEOUT_MS = 10_000

// ── Parser types ──

interface ParsedTalkBlock {
  enabled?: string
  summarize?: string
  source?: string
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

// ── YAML frontmatter parser (nested `talk:` block) ──

/**
 * Parses the `talk:` block from YAML frontmatter, including
 * the nested `voice:` sub-block. Returns null if no `talk:`
 * block is found or the block is empty.
 */
export function parseTalkBlock(frontmatter: string): ParsedTalkBlock | null {
  const lines = frontmatter.split("\n")

  // Find the `talk:` line at indent 0
  let i = 0
  while (i < lines.length) {
    if (lines[i].trimStart().startsWith("talk:")) break
    i++
  }
  if (i >= lines.length) return null
  i++ // skip past `talk:` line

  // Determine talk-level indentation from the first content line
  let talkIndent = -1
  for (let j = i; j < lines.length; j++) {
    const t = lines[j].trim()
    if (t !== "" && !t.startsWith("#")) {
      talkIndent = lines[j].length - t.length
      break
    }
  }
  if (talkIndent < 0) return null // empty block

  const result: ParsedTalkBlock = {}

  for (; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    const indent = line.length - trimmed.length

    // Exit talk block on a non-indented, non-empty, non-comment line
    if (indent === 0 && trimmed !== "" && !trimmed.startsWith("#")) break

    // Skip empty lines and comments
    if (trimmed === "" || trimmed.startsWith("#")) continue

    // Only process lines at the talk-level indent
    if (indent !== talkIndent) continue

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

        if (vi <= talkIndent) {
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

  // Allow empty talk block with voice as valid
  if (Object.keys(result).length === 0 && !result.voice) return null
  return result
}

// ── Config conversion ──

function parseBool(raw: string, fallback: boolean): boolean {
  return raw === "true" ? true : raw === "false" ? false : fallback
}

function toTalkConfig(raw: ParsedTalkBlock): DeepPartial<TalkConfig> {
  const cfg: DeepPartial<TalkConfig> = {}

  if (raw.enabled !== undefined) cfg.enabled = parseBool(raw.enabled, false)
  if (raw.summarize !== undefined) cfg.summarize = parseBool(raw.summarize, true)
  if (raw.source !== undefined) {
    const validSources = ["last-message", "last-paragraph", "last-sentence"]
    cfg.source = validSources.includes(raw.source)
      ? (raw.source as TalkConfig["source"])
      : undefined
  }
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

function mergeTalkConfig(
  base: TalkConfig,
  override: DeepPartial<TalkConfig>,
): TalkConfig {
  return {
    enabled: override.enabled ?? base.enabled,
    summarize: override.summarize ?? base.summarize,
    source: override.source ?? base.source,
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

function talkMdPaths(directory: string): string[] {
  return [
    join(directory, ".opencode", "agents", "talk.md"),
    join(directory, "agents", "talk.md"),
    join(homedir(), ".config", "opencode", "agents", "talk.md"),
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

function loadBaseConfig(directory: string): TalkConfig {
  for (const p of talkMdPaths(directory)) {
    try {
      if (!existsSync(p)) continue
      const fm = extractFrontmatter(readFileSync(p, "utf-8"))
      if (!fm) continue
      const block = parseTalkBlock(fm)
      if (!block) continue
      return mergeTalkConfig(HARD_DEFAULTS, toTalkConfig(block))
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
): DeepPartial<TalkConfig> | null {
  for (const p of agentMdPaths(directory, agentName)) {
    try {
      if (!existsSync(p)) continue
      const fm = extractFrontmatter(readFileSync(p, "utf-8"))
      if (!fm) continue
      const block = parseTalkBlock(fm)
      if (!block) continue
      return toTalkConfig(block)
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
 * Creates a talk config resolver for a given project directory.
 * Base config (from talk.md) is loaded once and cached.
 * Agent-level overrides are parsed and merged on each call,
 * with per-agent caching.
 */
export function createTalkConfigResolver(params: CreateResolverParams) {
  let baseConfig: TalkConfig | null = null
  let baseLoading = false
  let basePromise: Promise<TalkConfig> | null = null
  const agentCache = new Map<string, TalkConfig | null>()

  async function getBaseConfig(): Promise<TalkConfig> {
    if (baseConfig) return baseConfig
    if (baseLoading && basePromise) {
      return await Promise.race([
        basePromise,
        new Promise<TalkConfig>((_, reject) =>
          setTimeout(() => reject(new Error("base config load timed out")), CONFIG_LOAD_TIMEOUT_MS),
        ),
      ])
    }
    baseLoading = true
    basePromise = Promise.resolve(loadBaseConfig(params.directory))
    baseConfig = await basePromise
    return baseConfig
  }

  async function getTalkConfig(agentName: string): Promise<TalkConfig | null> {
    // Skip the talk agent itself to prevent recursion
    if (agentName === AGENT_NAME_TALK) return null

    const cached = agentCache.get(agentName)
    if (cached !== undefined) return cached

    try {
      const base = await getBaseConfig()
      const agentOverrides = loadAgentConfig(params.directory, agentName)

      // If agent has no `talk:` section at all, they don't opt in
      if (!agentOverrides) {
        agentCache.set(agentName, null)
        return null
      }

      // Merge base with agent overrides
      const merged = mergeTalkConfig(base, agentOverrides)

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

      const resolved: TalkConfig = { ...merged, voice: resolvedVoice }
      agentCache.set(agentName, resolved)
      return resolved
    } catch (err) {
      console.warn("[OpenTalk] config resolution failed for", agentName, err)
      agentCache.set(agentName, null)
      return null
    }
  }

  /**
   * Returns the base voice config (from talk.md defaults) with
   * credentials resolved. Used for inline `/say` commands.
   */
  async function getVoiceConfig(): Promise<VoiceConfig> {
    const base = await getBaseConfig()
    return resolveVoiceCredentials(base.voice, params.resolveProvider)
  }

  return { getTalkConfig, getVoiceConfig }
}
