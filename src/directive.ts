/**
 * Speak directive resolution — reads `speak:` from agent markdown
 * frontmatter and determines whether to summarize or read full responses.
 */
import { join } from "node:path"
import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import type { SpeakDirective } from "./types"

/**
 * Creates a speak directive cache and resolver.
 * Returns an object with a getDirective function.
 */
export function createDirectiveResolver(directory: string) {
  const cache = new Map<string, SpeakDirective | null>()

  function searchPaths(agentName: string): string[] {
    return [
      join(directory, ".opencode", "agents", `${agentName}.md`),
      join(directory, "agents", `${agentName}.md`),
      join(homedir(), ".config", "opencode", "agents", `${agentName}.md`),
    ]
  }

  /**
   * Reads the `speak:` frontmatter property from an agent markdown file.
   * Returns null if the agent has no speak directive.
   * Results are cached per agent name.
   */
  function getSpeakDirective(agentName: string): SpeakDirective | null {
    const cached = cache.get(agentName)
    if (cached !== undefined) return cached

    for (const p of searchPaths(agentName)) {
      try {
        if (!existsSync(p)) continue
        const content = readFileSync(p, "utf-8")

        const speakMatch = content.match(/^speak:\s*(.*)$/m)
        if (!speakMatch) {
          cache.set(agentName, null)
          return null
        }

        const value = speakMatch[1].trim()
        const directive: SpeakDirective =
          value === "true"
            ? { type: "full" }
            : { type: "instruction", value }

        cache.set(agentName, directive)
        return directive
      } catch (err) {
        console.warn(
          "[OpenTalk] failed to read directive from",
          p,
          err,
        )
      }
    }

    cache.set(agentName, null)
    return null
  }

  return { getSpeakDirective }
}
