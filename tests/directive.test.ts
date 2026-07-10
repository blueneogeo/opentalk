import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
}))

const fs = await import("node:fs")
const { createTalkConfigResolver } = await import("../src/config")

function talkMd(content: string): string {
  return `---\n${content}\n---\n`
}

describe("talk config resolution edge cases", () => {
  const mockResolver = vi.fn().mockResolvedValue(null)

  beforeEach(() => {
    vi.clearAllMocks()
    mockResolver.mockReset().mockResolvedValue(null)
  })

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY
  })

  it("uses hard defaults when no talk.md exists", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const { getVoiceConfig } = createTalkConfigResolver({
      directory: "/test",
      resolveProvider: mockResolver,
    })

    const voice = await getVoiceConfig()
    expect(voice.provider).toBe("say")
  })

  it("returns null when agent file does not exist", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      // talk.md exists
      if (String(p).includes("talk.md")) return true
      // agent files don't exist
      return false
    })
    vi.mocked(fs.readFileSync).mockReturnValue(talkMd(`talk:
  enabled: false
  process: true
  instruction: Base instruction
  model: base-model
  voice:
    provider: say
`))

    const { getTalkConfig } = createTalkConfigResolver({
      directory: "/test",
      resolveProvider: mockResolver,
    })

    const config = await getTalkConfig("nonexistent")
    expect(config).toBeNull()
  })

  it("provider=local keeps provider as local (no credential lookup)", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).includes("talk.md")) {
        return talkMd(`talk:
  enabled: false
  process: true
  instruction: Base
  model: base
  voice:
    provider: local
    voice: af_bella
`)
      }
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
    expect(config!.voice.provider).toBe("local")
    // Provider resolver should NOT have been called for "local"
    expect(mockResolver).not.toHaveBeenCalled()
  })

  it("provider=say keeps provider as say (no credential lookup)", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).includes("talk.md")) {
        return talkMd(`talk:
  enabled: false
  process: true
  instruction: Base
  model: base
  voice:
    provider: say
`)
      }
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
    expect(config!.voice.provider).toBe("say")
    expect(mockResolver).not.toHaveBeenCalled()
  })

  it("agent overrides voice.speed but inherits voice.provider from base", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).includes("talk.md")) {
        return talkMd(`talk:
  enabled: false
  process: true
  instruction: Base
  model: base
  voice:
    provider: say
    voice: af_bella
    speed: 1.0
`)
      }
      return talkMd(`mode: primary
talk:
  enabled: true
  voice:
    speed: 2.5
`)
    })

    const { getTalkConfig } = createTalkConfigResolver({
      directory: "/test",
      resolveProvider: mockResolver,
    })

    const config = await getTalkConfig("test-agent")
    expect(config!.voice.provider).toBe("say")
    expect(config!.voice.voice).toBe("af_bella")
    expect(config!.voice.speed).toBe(2.5)
  })

  it("process defaults to true when not specified", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).includes("talk.md")) {
        return talkMd(`talk:
  enabled: false
  process: true
  instruction: Base
  model: base
  voice:
    provider: say
`)
      }
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
    expect(config!.process).toBe(true)
  })
})
