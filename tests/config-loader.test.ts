import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Mock filesystem before importing the module under test
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
}))

const fs = await import("node:fs")
const { createTalkConfigResolver } = await import("../src/config")

// Helper to create a talk.md frontmatter string
function talkMd(content: string): string {
  return `---
${content}
---
`
}

// Base talk.md with defaults
const BASE_SPEAK_MD = talkMd(`mode: subagent
hidden: true
temperature: 0.1

talk:
  enabled: false
  process: true
  instruction: Summarize in one conversational sentence, under 25 words
  model: opencode-go/deepseek-v4-flash
  voice:
    provider: say
    voice: af_bella
    speed: 1.0
`)

describe("createTalkConfigResolver", () => {
  const mockResolver = vi.fn().mockResolvedValue(null)

  beforeEach(() => {
    vi.clearAllMocks()
    mockResolver.mockReset().mockResolvedValue(null)
  })

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY
  })

  it("returns null when agent has no talk section", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      // talk.md exists
      if (String(p).includes("talk.md")) return true
      // agent .md exists but has no talk section
      return true
    })
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).includes("talk.md")) return BASE_SPEAK_MD
      return `---
mode: primary
---
`
    })

    const { getTalkConfig } = createTalkConfigResolver({
      directory: "/test",
      resolveProvider: mockResolver,
    })

    const config = await getTalkConfig("test-agent")
    expect(config).toBeNull()
  })

  it("returns null when agent has talk.enabled: false", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).includes("talk.md")) return BASE_SPEAK_MD
      return talkMd(`mode: primary
talk:
  enabled: false
`)
    })

    const { getTalkConfig } = createTalkConfigResolver({
      directory: "/test",
      resolveProvider: mockResolver,
    })

    const config = await getTalkConfig("test-agent")
    expect(config).toBeNull()
  })

  it("returns resolved config with base defaults merged in", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).includes("talk.md")) return BASE_SPEAK_MD
      return talkMd(`mode: primary
talk:
  enabled: true
`)
    })

    const { getTalkConfig } = createTalkConfigResolver({
      directory: "/test",
      resolveProvider: mockResolver,
    })

    const config = await getTalkConfig("test-agent")
    expect(config).not.toBeNull()
    expect(config!.enabled).toBe(true)
    expect(config!.process).toBe(true)
    expect(config!.instruction).toBe("Summarize in one conversational sentence, under 25 words")
    expect(config!.model).toBe("opencode-go/deepseek-v4-flash")
    expect(config!.voice.provider).toBe("say")
    expect(config!.voice.voice).toBe("af_bella")
  })

  it("agent can override instruction", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).includes("talk.md")) return BASE_SPEAK_MD
      return talkMd(`mode: primary
talk:
  enabled: true
  instruction: Talk like a pirate, arr!
`)
    })

    const { getTalkConfig } = createTalkConfigResolver({
      directory: "/test",
      resolveProvider: mockResolver,
    })

    const config = await getTalkConfig("test-agent")
    expect(config!.instruction).toBe("Talk like a pirate, arr!")
    // Other fields still from base
    expect(config!.process).toBe(true)
  })

  it("agent can set process: false for raw passthrough", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).includes("talk.md")) return BASE_SPEAK_MD
      return talkMd(`mode: primary
talk:
  enabled: true
  process: false
`)
    })

    const { getTalkConfig } = createTalkConfigResolver({
      directory: "/test",
      resolveProvider: mockResolver,
    })

    const config = await getTalkConfig("test-agent")
    expect(config!.enabled).toBe(true)
    expect(config!.process).toBe(false)
  })

  it("agent can override voice provider", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).includes("talk.md")) return BASE_SPEAK_MD
      return talkMd(`mode: primary
talk:
  enabled: true
  voice:
    provider: local
    voice: af_nicole
`)
    })

    const { getTalkConfig } = createTalkConfigResolver({
      directory: "/test",
      resolveProvider: mockResolver,
    })

    const config = await getTalkConfig("test-agent")
    expect(config!.voice.provider).toBe("local")
    expect(config!.voice.voice).toBe("af_nicole")
    // Speed inherited from base
    expect(config!.voice.speed).toBe(1.0)
  })

  it("falls back to say when provider resolution fails", async () => {
    // Ensure no env var leaks in
    delete process.env.OPENROUTER_API_KEY

    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).includes("talk.md")) return BASE_SPEAK_MD
      return talkMd(`mode: primary
talk:
  enabled: true
  voice:
    provider: nonexistent-provider
    model: some-model
`)
    })

    const { getTalkConfig } = createTalkConfigResolver({
      directory: "/test",
      resolveProvider: mockResolver, // resolves to null
    })

    const config = await getTalkConfig("test-agent")
    expect(config!.voice.provider).toBe("say")
  })

  it("talk agent itself returns null (no recursion)", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)

    const { getTalkConfig } = createTalkConfigResolver({
      directory: "/test",
      resolveProvider: mockResolver,
    })

    const config = await getTalkConfig("talk")
    expect(config).toBeNull()
  })

  it("caches resolved config per agent", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).includes("talk.md")) return BASE_SPEAK_MD
      return talkMd(`mode: primary
talk:
  enabled: true
`)
    })

    const { getTalkConfig } = createTalkConfigResolver({
      directory: "/test",
      resolveProvider: mockResolver,
    })

    await getTalkConfig("cached-agent")
    await getTalkConfig("cached-agent")

    // Base talk.md should only be read once
    const readCalls = vi.mocked(fs.readFileSync).mock.calls.filter(
      (c: any) => String(c[0]).includes("talk.md"),
    )
    expect(readCalls.length).toBe(1)
  })
})
