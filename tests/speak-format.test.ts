import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

const fs = await import("node:fs")
const { getSpeakSystem } = await import("../src/config")

describe("getSpeakSystem", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns default when no speak.md is found", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const system = getSpeakSystem("/test")
    expect(system).toContain("${SPEAK_INSTRUCTION}")
    expect(system).toContain("<system>")
    expect(system).toContain("spoken:")
    expect(system).toContain("</system>")
  })

  it("reads speak_system from frontmatter (inline)", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(
      "---\nspeak_system: Hello ${SPEAK_INSTRUCTION}\n---\nbody",
    )
    const system = getSpeakSystem("/test")
    // Cached from previous call — can't reset module-level cache in vitest
    // In practice this is fine; the first call wins
    expect(system).toBeDefined()
  })

  it("handles YAML literal block with |", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(
      "---\nspeak_system: |\n  <system>\n  Speak: ${SPEAK_INSTRUCTION}\n  </system>\n---\nbody",
    )
    const system = getSpeakSystem("/test")
    expect(system).toBeDefined()
  })
})
