import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
}))

const fs = await import("node:fs")
const { createDirectiveResolver } = await import("../src/directive")

describe("getSpeakDirective", () => {
  const makeResolver = () => createDirectiveResolver("/test/dir")

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY
  })

  it("returns null when agent file doesn't exist", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const { getSpeakDirective } = makeResolver()
    expect(getSpeakDirective("nonexistent")).toBeNull()
  })

  it("parses speak: true as full directive", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue("---\nspeak: true\n---\ncontent")
    const { getSpeakDirective } = makeResolver()
    expect(getSpeakDirective("test-agent")).toEqual({ type: "full" })
  })

  it("parses speak: string as instruction directive", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(
      "---\nspeak: Summarize in one sentence\n---\ncontent",
    )
    const { getSpeakDirective } = makeResolver()
    expect(getSpeakDirective("test-agent")).toEqual({
      type: "instruction",
      value: "Summarize in one sentence",
    })
  })

  it("returns null when no speak property exists", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue("---\nmode: subagent\n---\ncontent")
    const { getSpeakDirective } = makeResolver()
    expect(getSpeakDirective("test-agent")).toBeNull()
  })

  it("caches results per agent name", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue("---\nspeak: true\n---\ncontent")
    const { getSpeakDirective } = makeResolver()
    getSpeakDirective("cached-agent")
    getSpeakDirective("cached-agent")
    expect(fs.readFileSync).toHaveBeenCalledTimes(1)
  })
})
