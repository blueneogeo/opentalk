/**
 * TTS configuration loading and parsing.
 *
 * Reads the `tts:` block and `speak_format:` from the speak agent's
 * YAML frontmatter.
 */
import { join } from "node:path"
import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import type { TtsConfig } from "./types"

// ── Constants ──

const DEFAULT_CONFIG: TtsConfig = {
  engine: "kokoro",
  model: "hexgrad/kokoro-82m",
  voice: "af_bella",
  speed: 1.0,
  responseFormat: "mp3",
}

const CONFIG_LOAD_TIMEOUT_MS = 10_000

const VALID_ENGINES = new Set(["say", "openrouter", "kokoro"])

function isValidEngine(v: string): v is TtsConfig["engine"] {
  return VALID_ENGINES.has(v)
}

// ── YAML frontmatter parser ──

/**
 * Parses a `tts:` block from YAML frontmatter.
 * Handles flat key-value pairs with indentation.
 * Returns null if no `tts:` block is found.
 */
export function parseTtsBlock(frontmatter: string): Record<string, string> | null {
  const lines = frontmatter.split("\n")
  let inTts = false
  const result: Record<string, string> = {}

  for (const line of lines) {
    if (line.trimStart().startsWith("tts:")) {
      inTts = true
      continue
    }
    if (!inTts) continue
    if (
      line.length > 0 &&
      line[0] !== " " &&
      line[0] !== "\t" &&
      line[0] !== "#"
    ) {
      break
    }
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    const m = trimmed.match(/^([\w_]+):\s*(.*)$/)
    if (m) result[m[1]] = m[2]
  }

  return Object.keys(result).length > 0 ? result : null
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

// ── Config loading ──

interface LoadConfigParams {
  directory: string
  resolveProvider: ProviderResolver
}

function searchPaths(directory: string): string[] {
  return [
    join(directory, ".opencode", "agents", "speak.md"),
    join(directory, "agents", "speak.md"),
    join(homedir(), ".config", "opencode", "agents", "speak.md"),
  ]
}

async function buildConfig(
  rawBlock: Record<string, string>,
  directory: string,
  resolveProvider: ProviderResolver,
): Promise<TtsConfig> {
  const engine = isValidEngine(rawBlock.engine)
    ? rawBlock.engine
    : DEFAULT_CONFIG.engine

  // Parse speed safely — Number("0") is falsy so we guard NaN instead of using ||
  const speedRaw = Number(rawBlock.speed)
  const speed = Number.isNaN(speedRaw) ? DEFAULT_CONFIG.speed : speedRaw

  const config: TtsConfig = {
    engine,
    model: rawBlock.model ?? DEFAULT_CONFIG.model,
    voice: rawBlock.voice ?? DEFAULT_CONFIG.voice,
    speed,
    responseFormat:
      rawBlock.response_format === "pcm"
        ? "pcm"
        : DEFAULT_CONFIG.responseFormat,
  }

  // Credential resolution for openrouter engine
  if (engine === "openrouter") {
    if (rawBlock.api_provider) {
      try {
        const provider = await resolveProvider(rawBlock.api_provider)
        if (provider) {
          if (provider.baseUrl) config.baseUrl = provider.baseUrl
          if (provider.apiKey) config.apiKey = provider.apiKey
        }
      } catch (err) {
        console.warn("[OpenTalk] provider resolution failed:", err)
      }
    }

    if (!config.apiKey && rawBlock.api_key) {
      config.apiKey = resolveEnv(rawBlock.api_key)
    }
    if (!config.baseUrl && rawBlock.base_url) {
      config.baseUrl = rawBlock.base_url
    }
    if (!config.apiKey) {
      config.apiKey = process.env.OPENROUTER_API_KEY
    }

    if (!config.apiKey) {
      config.engine = "say"
    }
  }

  return config
}

async function loadConfigFromDisk(
  directory: string,
  resolveProvider: ProviderResolver,
): Promise<TtsConfig> {
  for (const p of searchPaths(directory)) {
    try {
      if (!existsSync(p)) continue
      const content = readFileSync(p, "utf-8")
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
      if (!fmMatch) continue
      const block = parseTtsBlock(fmMatch[1])
      if (block) {
        return buildConfig(block, directory, resolveProvider)
      }
    } catch (err) {
      console.warn("[OpenTalk] failed to read config from", p, err)
    }
  }

  return DEFAULT_CONFIG
}

// ── Public API ──

/**
 * Creates a TTS config loader with caching and timeout.
 * Returns a function that returns a Promise<TtsConfig>.
 */
export function createConfigLoader(params: LoadConfigParams) {
  let cached: TtsConfig | null = null
  let loading = false
  let loadPromise: Promise<TtsConfig> | null = null

  return async function getTtsConfig(): Promise<TtsConfig> {
    if (cached) return cached

    if (loading && loadPromise) {
      const result = await Promise.race([
        loadPromise,
        new Promise<TtsConfig>((_, reject) =>
          setTimeout(
            () => reject(new Error("TTS config load timed out")),
            CONFIG_LOAD_TIMEOUT_MS,
          ),
        ),
      ]).catch(() => {
        console.warn("[OpenTalk] TTS config load timed out, falling back to say")
        return { engine: "say" as const, model: "", voice: "", speed: 1.0, responseFormat: "mp3" as const }
      })
      return result
    }

    loading = true
    loadPromise = loadConfigFromDisk(params.directory, params.resolveProvider)
      .catch((err) => {
        console.warn(
          "[OpenTalk] loading TTS config failed, falling back to say:",
          err,
        )
        return {
          engine: "say" as const,
          model: "",
          voice: "",
          speed: 1.0,
          responseFormat: "mp3" as const,
        }
      })
      .then((cfg) => {
        cached = cfg
        return cfg
      })

    return loadPromise
  }
}
